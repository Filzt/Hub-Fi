// Processamento de um pedido do ML.
//
//   analisarPedido  — só leitura: lê ML e Sankhya, monta o incluirNota e o parceiro
//                     (se for comprador novo) e classifica o pedido.
//   gravarPedido    — escreve no Sankhya (parceiro + nota). Só roda com MODO
//                     "manual" (botão/API) ou "automatico" (webhook). Em "sombra", nunca.
//
// Garantias contra pedido duplicado:
//   1. trava por pedido e por CPF/CNPJ no Durable Object (atômica);
//   2. dentro da trava, relê TGFCAB pela OBSERVACAO (16 primeiros caracteres)
//      antes de incluir — pega pedido criado pela Base, à mão ou por nós;
//   3. se a resposta do incluirNota se perder (timeout), a confirmação é feita
//      pela OBSERVACAO em vez de tentar de novo às cegas.

import { meliGet } from "./meli.ts";
import {
  type BillingML,
  type CepSankhya,
  compararComBase,
  consolidar,
  dataSaoPaulo,
  type DocBase,
  type EntradaNota,
  freteVendedorCentavos,
  montarNota,
  montarParceiro,
  type OrderML,
  reais,
  skuValido,
  soDigitos,
  sqlTexto,
} from "./nota.ts";
import { confirmarNota, consultar, incluirNota, salvarParceiro } from "./sankhya.ts";
import { type Evento, type Pedido, storeStub } from "./store.ts";
import { type Env, ErroDefinitivo, ErroTemporario } from "./tipos.ts";

interface Analise {
  pedido: Pedido;
  entrada: EntradaNota | null; // codparc = 0 quando o parceiro ainda vai ser criado
  parceiroNovo: Record<string, string> | null;
  documento: string;
  observacoes: string[];
}

export async function analisarPedido(env: Env, orderId: string): Promise<Analise> {
  if (!/^\d{6,20}$/.test(orderId)) throw new ErroDefinitivo(`order_id inválido: ${orderId}`);
  const alertas: string[] = [];

  // 1. Pedido e pack no ML ------------------------------------------------------
  const principal = await meliGet<OrderML>(env, `/orders/${orderId}`);
  let orders: OrderML[] = [principal];
  if (principal.pack_id) {
    try {
      // GET /packs/{id} → { orders: [{id}], shipment: {id} } (confirmado em 24/09/2026)
      const pack = await meliGet<{ orders?: Array<{ id: number | string }> }>(env, `/packs/${principal.pack_id}`);
      const ids = (pack.orders ?? []).map((o) => String(o.id)).filter((id) => id !== String(principal.id));
      for (const id of ids) orders.push(await meliGet<OrderML>(env, `/orders/${id}`));
    } catch (e) {
      if (e instanceof ErroTemporario) throw e;
      alertas.push(`pack ${principal.pack_id} não lido (${(e as Error).message}); só a order ${orderId} entrou`);
      orders = [principal];
    }
  }
  const p = consolidar(orders);
  alertas.push(...p.alertas);
  const cancelado = p.status.some((s) => s === "cancelled");
  const pago = p.status.every((s) => s === "paid");

  // 2. Frete cobrado do vendedor e comprador --------------------------------------
  let freteCentavos = 0;
  if (p.shippingId) {
    const costs = await meliGet<{ senders?: Array<{ user_id?: number; cost?: number }> }>(
      env, `/shipments/${p.shippingId}/costs`, { "x-format-new": "true" },
    );
    freteCentavos = freteVendedorCentavos(costs, env.MELI_USER_ID);
  } else {
    alertas.push("pedido sem shipping.id — frete não calculado");
  }

  let billing: BillingML | null = null;
  if (p.billingInfoId) {
    const bi = await meliGet<Record<string, any>>(env, `/orders/billing-info/MLB/${p.billingInfoId}`);
    billing = (bi?.buyer?.billing_info ?? bi?.billing_info ?? null) as BillingML | null;
  }
  const documento = soDigitos(billing?.identification?.number);

  // 3. Sankhya: produto, parceiro e pedido já existente ---------------------------
  const skus = [...new Set(p.itens.map((i) => i.sku).filter(skuValido))];
  const produtos = skus.length
    ? await consultar(env, `SELECT CODPROD, REFERENCIA FROM TGFPRO WHERE REFERENCIA IN (${skus.map(sqlTexto).join(",")})`)
    : [];
  const porSku = new Map<string, number[]>();
  for (const r of produtos) {
    const k = String(r.REFERENCIA);
    porSku.set(k, [...(porSku.get(k) ?? []), Number(r.CODPROD)]);
  }
  const itensNota: EntradaNota["itens"] = [];
  let bloqueio = "";
  for (const i of p.itens) {
    const cods = porSku.get(i.sku) ?? [];
    if (cods.length !== 1) {
      bloqueio ||= cods.length ? `SKU ${i.sku} ambíguo no Sankhya (${cods.join(",")})` : `SKU ${i.sku || "(vazio)"} sem cadastro no Sankhya`;
      continue;
    }
    itensNota.push({ codprod: cods[0], quantidade: i.quantidade, precoCentavos: i.precoCentavos });
  }

  let codparc: number | null = null;
  let parceiroNovo: Record<string, string> | null = null;
  if (!documento) {
    bloqueio ||= "sem CPF/CNPJ do comprador no billing-info";
  } else {
    codparc = await buscarParceiro(env, documento);
    if (!codparc) {
      const cepDig = soDigitos(billing?.address?.zip_code);
      const linhas = cepDig.length === 8
        ? await consultar(env, `SELECT CODEND, CODBAI, CODCID FROM TSICEP WHERE CEP = ${sqlTexto(cepDig)}`)
        : [];
      const cep: CepSankhya | null = linhas.length
        ? { CODEND: Number(linhas[0].CODEND), CODBAI: Number(linhas[0].CODBAI), CODCID: Number(linhas[0].CODCID) }
        : null;
      const r = montarParceiro(billing, cep);
      alertas.push(...r.alertas);
      if (r.bloqueio) bloqueio ||= `parceiro novo: ${r.bloqueio}`;
      else parceiroNovo = r.campos;
    }
  }

  const observacoes = [...new Set([p.chave, ...p.orderIds])].map(soDigitos).filter(Boolean);
  const docsErp = await documentosNoErp(env, observacoes);
  const nfAutorizada = docsErp.some((d) => d.CODTIPOPER === 1130 && d.STATUSNFE === "A");
  const tem1090 = docsErp.some((d) => d.CODTIPOPER === 1090);

  // 4. Classificação ----------------------------------------------------------------
  const entrada: EntradaNota | null =
    !bloqueio && (codparc || parceiroNovo)
      ? {
          codparc: codparc ?? 0,
          dtneg: dataSaoPaulo(p.dataCriacao),
          observacao: p.chave, // pack_id quando existe — mesmo padrão da Base
          comissaoCentavos: p.comissaoCentavos,
          freteCentavos,
          itens: itensNota,
        }
      : null;
  const comparacao = entrada && codparc ? compararComBase(entrada, docsErp) : null;

  let situacao: string;
  if (cancelado) {
    situacao = "cancelado";
    if (nfAutorizada) alertas.push("CANCELADO no ML com NF 1130 autorizada no Sankhya — fiscal precisa agir");
    else if (tem1090) alertas.push("CANCELADO no ML com pedido 1090 no Sankhya — cancelar o pedido no ERP");
  } else if (tem1090) {
    situacao = comparacao?.divergencias.length ? "divergente" : "no_erp";
  } else if (!pago) situacao = "aguardando_pagamento";
  else if (p.itens.some((i) => i.comissaoCentavos <= 0)) {
    // Na notificação da venda o ML às vezes ainda não calculou o sale_fee (visto em
    // 24/09/2026: 0,00 no 1º aviso, 219,05 no seguinte). Não grava com comissão zerada.
    situacao = "aguardando_comissao";
  } else if (bloqueio || !entrada) situacao = "bloqueado";
  else situacao = "pronto";

  const pedido: Pedido = {
    chave: p.chave,
    order_ids: p.orderIds.join(","),
    data_ml: p.dataCriacao,
    status_ml: p.status.join(","),
    situacao,
    total: p.totalCentavos / 100,
    comissao: p.comissaoCentavos / 100,
    frete: freteCentavos / 100,
    codparc,
    nunotas_base: docsErp.length ? docsErp.map((d) => `${d.CODTIPOPER}:${d.NUNOTA}`).join(",") : null,
    nota_json: entrada ? JSON.stringify(montarNota(entrada)) : null,
    analise_json: JSON.stringify({
      bloqueio: bloqueio || null,
      alertas,
      comparacao,
      parceiroNovo: parceiroNovo ? { ...parceiroNovo, CGC_CPF: mascarar(parceiroNovo.CGC_CPF) } : null,
      nfAutorizada,
      itens: p.itens,
      erp: docsErp,
    }),
    atualizado_em: Date.now(),
  };
  return { pedido, entrada, parceiroNovo, documento, observacoes };
}

/** Analisa, salva e — em modo automático — grava o que estiver pronto. */
export async function processarPedido(env: Env, orderId: string): Promise<Pedido> {
  const store = storeStub(env);
  const a = await analisarPedido(env, orderId);
  await store.salvarPedido(a.pedido);
  await store.log(nivel(a.pedido.situacao), a.pedido.chave, resumo(a));
  if (env.MODO === "automatico" && a.pedido.situacao === "pronto") return gravarPedido(env, orderId, a);
  return a.pedido;
}

/**
 * Grava parceiro (se novo) e pedido 1090 no Sankhya. Idempotente: pode ser
 * chamado de novo após qualquer falha sem duplicar.
 */
export async function gravarPedido(env: Env, orderId: string, analise?: Analise): Promise<Pedido> {
  if (env.MODO !== "manual" && env.MODO !== "automatico") {
    throw new ErroDefinitivo(`gravação desligada (MODO=${env.MODO})`);
  }
  const store = storeStub(env);
  const a = analise ?? (await analisarPedido(env, orderId));
  await store.salvarPedido(a.pedido);
  const chave = a.pedido.chave;
  if (a.pedido.situacao !== "pronto" || !a.entrada) {
    throw new ErroDefinitivo(`pedido ${chave} não está pronto para gravar (situação: ${a.pedido.situacao})`);
  }

  const travaPedido = `pedido:${chave}`;
  const travaParc = `parceiro:${a.documento}`;
  if (!(await store.travar(travaPedido, 5 * 60_000))) {
    throw new ErroTemporario(`gravação do pedido ${chave} já em andamento`);
  }
  try {
    await store.marcarGravacao(chave, "gravando");

    // Releitura dentro da trava: alguém pode ter lançado o pedido nesse meio-tempo.
    const existentes = (await documentosNoErp(env, a.observacoes)).filter((d) => d.CODTIPOPER === 1090);
    if (existentes.length) {
      await store.marcarGravacao(chave, "gravado", { nunota: existentes[0].NUNOTA });
      await store.log("aviso", chave, `pedido já existia no Sankhya (NUNOTA ${existentes[0].NUNOTA}) — nada gravado`);
      return (await store.pedido(chave)) as Pedido;
    }

    // Parceiro: cria só se ainda não existir (trava por documento evita duplicata
    // quando o mesmo comprador novo fecha dois pedidos ao mesmo tempo).
    let codparc = a.entrada.codparc;
    if (!codparc) {
      if (!a.parceiroNovo) throw new ErroDefinitivo("parceiro ausente e sem dados para criar");
      if (!(await store.travar(travaParc, 2 * 60_000))) {
        throw new ErroTemporario(`criação do parceiro ${mascarar(a.documento)} já em andamento`);
      }
      try {
        codparc = (await buscarParceiro(env, a.documento)) ?? 0;
        if (!codparc) {
          const criado = await salvarParceiro(env, a.parceiroNovo);
          // Confirma pela leitura: vale mesmo se a resposta vier sem a chave.
          codparc = (await buscarParceiro(env, a.documento)) ?? criado ?? 0;
          if (!codparc) throw new ErroDefinitivo("parceiro gravado, mas não encontrado pelo CPF/CNPJ");
          await store.log("info", chave, `parceiro criado: CODPARC ${codparc} (${mascarar(a.documento)})`);
        }
      } finally {
        await store.destravar(travaParc);
      }
    }

    const corpo = montarNota({ ...a.entrada, codparc });
    let nunota: number | null = null;
    try {
      nunota = await incluirNota(env, corpo);
    } catch (e) {
      // Resposta perdida (timeout/rede) não quer dizer que não gravou: confere antes de falhar.
      if (!(e instanceof ErroTemporario)) throw e;
    }
    nunota ??= (await documentosNoErp(env, a.observacoes)).find((d) => d.CODTIPOPER === 1090)?.NUNOTA ?? null;
    if (!nunota) throw new ErroTemporario("incluirNota sem confirmação — pedido não encontrado no Sankhya");

    await store.marcarGravacao(chave, "gravado", { nunota });
    await store.log("info", chave, `pedido gravado no Sankhya: NUNOTA ${nunota}, CODPARC ${codparc}, total ${reais(Math.round(a.pedido.total * 100))}`);

    // Confirmação separada: o pedido já existe; se confirmar falhar, fica registrado
    // e pode ser refeito pelo painel sem regravar nada.
    const conf = await confirmarPedidoErp(env, nunota);
    if (!conf.ok) {
      await store.marcarGravacao(chave, "gravado", { nunota });
      await store.log("aviso", chave, `NUNOTA ${nunota} gravado mas NÃO confirmado: ${conf.motivo}`);
    }
    const final = await analisarPedido(env, orderId); // reflete o pedido recém-criado
    await store.salvarPedido(final.pedido);
    return (await store.pedido(chave)) as Pedido;
  } catch (e) {
    await store.marcarGravacao(chave, "erro", { erro: (e as Error).message });
    await store.log("erro", chave, `gravação falhou: ${(e as Error).message}`);
    throw e;
  } finally {
    await store.destravar(travaPedido);
  }
}

/** Processa um evento da fila e registra o resultado (ok / retry / erro definitivo). */
export async function processarEvento(env: Env, ev: Evento): Promise<void> {
  const store = storeStub(env);
  if (ev.topic !== "orders_v2") {
    await store.ignorarEvento(ev.id, "tópico ainda não processado nesta fase");
    return;
  }
  const m = ev.resource.match(/\/orders\/(\d+)/);
  if (!m) {
    await store.concluirEvento(ev.id, { ok: false, erro: `resource inesperado: ${ev.resource}` });
    return;
  }
  try {
    await processarPedido(env, m[1]);
    await store.concluirEvento(ev.id, { ok: true });
  } catch (e) {
    const erro = e as Error;
    const temporario = !(erro instanceof ErroDefinitivo);
    await store.concluirEvento(ev.id, { ok: false, temporario, erro: erro.message });
    await store.log("erro", m[1], `${erro.name}: ${erro.message}`);
  }
}

/**
 * Confirma um pedido 1090 já existente (STATUSNOTA A → L) e confere pela leitura.
 * Só aceita pedido 1090 cuja OBSERVACAO comece com número do ML (16 dígitos).
 */
export async function confirmarPedidoErp(env: Env, nunota: number): Promise<{ ok: boolean; status: string | null; motivo?: string }> {
  if (env.MODO !== "manual" && env.MODO !== "automatico") {
    return { ok: false, status: null, motivo: `gravação desligada (MODO=${env.MODO})` };
  }
  const ler = async () =>
    (await consultar(env, `SELECT CODTIPOPER, STATUSNOTA, TRIM(OBSERVACAO) OBS FROM TGFCAB WHERE NUNOTA = ${Number(nunota)}`))[0];
  const antes = await ler();
  if (!antes) return { ok: false, status: null, motivo: "NUNOTA não encontrado" };
  if (Number(antes.CODTIPOPER) !== 1090 || !/^\d{16}/.test(String(antes.OBS ?? ""))) {
    return { ok: false, status: String(antes.STATUSNOTA), motivo: "não é pedido 1090 do ML" };
  }
  if (antes.STATUSNOTA === "L") return { ok: true, status: "L" };
  let erro = "";
  try {
    await confirmarNota(env, nunota);
  } catch (e) {
    erro = (e as Error).message;
  }
  const depois = await ler();
  const status = depois ? String(depois.STATUSNOTA) : null;
  return status === "L" ? { ok: true, status } : { ok: false, status, motivo: erro || `STATUSNOTA continua ${status}` };
}

// ---------------------------------------------------------------------------

async function buscarParceiro(env: Env, documento: string): Promise<number | null> {
  const r = await consultar(env, `SELECT CODPARC FROM TGFPAR WHERE CGC_CPF = ${sqlTexto(documento)}`);
  return r.length ? Number(r[0].CODPARC) : null;
}

type DocErp = DocBase & { STATUSNFE: string | null };

/** Pedidos (1090) e notas (1130) que já citam o pedido do ML na OBSERVACAO. */
async function documentosNoErp(env: Env, observacoes: string[]): Promise<DocErp[]> {
  if (!observacoes.length) return [];
  // 16 primeiros caracteres: o operador às vezes acrescenta texto depois do número
  // (ex.: "2000014970833969 - IMEI ..."), 25 notas assim em 24/09/2026.
  const cab = await consultar(
    env,
    `SELECT NUNOTA, CODTIPOPER, TRIM(OBSERVACAO) OBSERVACAO, VLRNOTA, AD_VLRCOMISSAO, CODPARC, STATUSNFE
     FROM TGFCAB WHERE SUBSTR(TRIM(OBSERVACAO), 1, 16) IN (${observacoes.map(sqlTexto).join(",")})
       AND CODTIPOPER IN (1090, 1130)`,
  );
  const nunotas = cab.filter((c) => Number(c.CODTIPOPER) === 1090).map((c) => Number(c.NUNOTA));
  const itens = nunotas.length
    ? await consultar(env, `SELECT NUNOTA, CODPROD, QTDNEG, VLRUNIT FROM TGFITE WHERE NUNOTA IN (${nunotas.join(",")})`)
    : [];
  return cab.map((c) => ({
    NUNOTA: Number(c.NUNOTA),
    CODTIPOPER: Number(c.CODTIPOPER),
    OBSERVACAO: String(c.OBSERVACAO),
    VLRNOTA: c.VLRNOTA == null ? null : Number(c.VLRNOTA),
    AD_VLRCOMISSAO: c.AD_VLRCOMISSAO == null ? null : Number(c.AD_VLRCOMISSAO),
    CODPARC: c.CODPARC == null ? null : Number(c.CODPARC),
    STATUSNFE: c.STATUSNFE == null ? null : String(c.STATUSNFE),
    itens: itens
      .filter((i) => Number(i.NUNOTA) === Number(c.NUNOTA))
      .map((i) => ({ CODPROD: Number(i.CODPROD), QTDNEG: Number(i.QTDNEG), VLRUNIT: Number(i.VLRUNIT) })),
  }));
}

function mascarar(doc: string): string {
  return doc.length > 5 ? `${doc.slice(0, 3)}***${doc.slice(-2)}` : "***";
}

function nivel(situacao: string): "info" | "aviso" | "erro" {
  return situacao === "no_erp" || situacao === "pronto" ? "info" : "aviso";
}

function resumo(a: Analise): string {
  const x = JSON.parse(a.pedido.analise_json) as { bloqueio: string | null; comparacao: { divergencias: string[] } | null };
  return (
    `${a.pedido.situacao} — total ${a.pedido.total.toFixed(2)}, comissão ${a.pedido.comissao.toFixed(2)}, frete ${a.pedido.frete.toFixed(2)}` +
    (a.parceiroNovo ? " — parceiro novo" : "") +
    (x.bloqueio ? ` — ${x.bloqueio}` : "") +
    (x.comparacao?.divergencias.length ? ` — ${x.comparacao.divergencias.join(" | ")}` : "")
  );
}
