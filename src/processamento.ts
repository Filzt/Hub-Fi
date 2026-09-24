// Processamento de um pedido do ML em modo SOMBRA: lê ML e Sankhya, monta o
// incluirNota que SERIA enviado e compara com o que a Base gravou. Não grava nada.

import { meliGet } from "./meli.ts";
import {
  compararComBase,
  consolidar,
  dataSaoPaulo,
  type DocBase,
  type EntradaNota,
  freteVendedorCentavos,
  montarNota,
  type OrderML,
  reais,
  skuValido,
  soDigitos,
  sqlTexto,
} from "./nota.ts";
import { consultar } from "./sankhya.ts";
import { type Evento, type Pedido, storeStub } from "./store.ts";
import { type Env, ErroDefinitivo, ErroTemporario } from "./tipos.ts";

export async function processarPedido(env: Env, orderId: string): Promise<Pedido> {
  if (!/^\d{6,20}$/.test(orderId)) throw new ErroDefinitivo(`order_id inválido: ${orderId}`);
  const store = storeStub(env);
  const alertas: string[] = [];

  // 1. Pedido e pack no ML ------------------------------------------------------
  const principal = await meliGet<OrderML>(env, `/orders/${orderId}`);
  let orders: OrderML[] = [principal];
  if (principal.pack_id) {
    try {
      // Endpoint de pack: formato { orders: [{id}] } — confirmar no primeiro pack real.
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

  // 2. Frete cobrado do vendedor e documento do comprador ------------------------
  let freteCentavos = 0;
  if (p.shippingId) {
    const costs = await meliGet<{ senders?: Array<{ user_id?: number; cost?: number }> }>(
      env, `/shipments/${p.shippingId}/costs`, { "x-format-new": "true" },
    );
    freteCentavos = freteVendedorCentavos(costs, env.MELI_USER_ID);
  } else {
    alertas.push("pedido sem shipping.id — frete não calculado");
  }

  let documento = "";
  if (p.billingInfoId) {
    const bi = await meliGet<Record<string, any>>(env, `/orders/billing-info/MLB/${p.billingInfoId}`);
    // Formato da resposta ainda não visto em produção: aceita os dois aninhamentos da doc.
    const b = bi?.buyer?.billing_info ?? bi?.billing_info ?? bi;
    documento = soDigitos(b?.identification?.number);
  }
  if (!documento) alertas.push("CPF/CNPJ do comprador não encontrado no billing-info");

  // 3. Sankhya: produto, parceiro e o que a Base já gravou ------------------------
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
  if (documento) {
    const parc = await consultar(env, `SELECT CODPARC FROM TGFPAR WHERE CGC_CPF = ${sqlTexto(documento)}`);
    codparc = parc.length ? Number(parc[0].CODPARC) : null;
    if (!codparc) bloqueio ||= "parceiro novo — criação de parceiro ainda não implementada";
  } else {
    bloqueio ||= "sem documento do comprador";
  }

  const observacoes = [...new Set([p.chave, ...p.orderIds])].map(soDigitos).filter(Boolean);
  // Casa pelos 16 primeiros caracteres: o operador às vezes acrescenta texto depois do
  // número (ex.: "2000014970833969 - IMEI ..."), 25 notas assim em 24/09/2026.
  const cab = await consultar(
    env,
    `SELECT NUNOTA, CODTIPOPER, TRIM(OBSERVACAO) OBSERVACAO, SUBSTR(TRIM(OBSERVACAO), 1, 16) NUMML,
            VLRNOTA, AD_VLRCOMISSAO, AD_FRETEMKTP, CODPARC, STATUSNFE
     FROM TGFCAB WHERE SUBSTR(TRIM(OBSERVACAO), 1, 16) IN (${observacoes.map(sqlTexto).join(",")})
       AND CODTIPOPER IN (1090, 1130)`,
  );
  const nunotas1090 = cab.filter((c) => Number(c.CODTIPOPER) === 1090).map((c) => Number(c.NUNOTA));
  const itensBase = nunotas1090.length
    ? await consultar(env, `SELECT NUNOTA, CODPROD, QTDNEG, VLRUNIT FROM TGFITE WHERE NUNOTA IN (${nunotas1090.join(",")})`)
    : [];
  const docsBase: DocBase[] = cab.map((c) => ({
    NUNOTA: Number(c.NUNOTA),
    CODTIPOPER: Number(c.CODTIPOPER),
    OBSERVACAO: String(c.OBSERVACAO),
    VLRNOTA: c.VLRNOTA == null ? null : Number(c.VLRNOTA),
    AD_VLRCOMISSAO: c.AD_VLRCOMISSAO == null ? null : Number(c.AD_VLRCOMISSAO),
    CODPARC: c.CODPARC == null ? null : Number(c.CODPARC),
    itens: itensBase
      .filter((i) => Number(i.NUNOTA) === Number(c.NUNOTA))
      .map((i) => ({ CODPROD: Number(i.CODPROD), QTDNEG: Number(i.QTDNEG), VLRUNIT: Number(i.VLRUNIT) })),
  }));
  const nfAutorizada = cab.some((c) => Number(c.CODTIPOPER) === 1130 && c.STATUSNFE === "A");
  const baseCasouPor = [...new Set(cab.map((c) => (c.NUMML === p.chave ? "chave" : "order_id")))];

  // 4. Nota que seria enviada + comparação ----------------------------------------
  const entrada: EntradaNota | null =
    !bloqueio && codparc
      ? {
          codparc,
          dtneg: dataSaoPaulo(p.dataCriacao),
          observacao: p.chave, // premissa: pack_id quando existe — conferir com baseCasouPor
          comissaoCentavos: p.comissaoCentavos,
          freteCentavos,
          itens: itensNota,
        }
      : null;
  const comparacao = entrada ? compararComBase(entrada, docsBase) : null;

  let situacao: string;
  if (cancelado) {
    situacao = "cancelado";
    if (nfAutorizada) alertas.push("CANCELADO no ML com NF 1130 autorizada no Sankhya — fiscal precisa agir");
  } else if (!pago) situacao = "aguardando_pagamento";
  else if (bloqueio) situacao = "bloqueado";
  else if (!comparacao?.encontrado) situacao = "sem_base";
  else situacao = comparacao.divergencias.length ? "divergente" : "sombra_ok";

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
    nunotas_base: docsBase.length ? docsBase.map((d) => `${d.CODTIPOPER}:${d.NUNOTA}`).join(",") : null,
    nota_json: entrada ? JSON.stringify(montarNota(entrada)) : null,
    analise_json: JSON.stringify({
      bloqueio: bloqueio || null,
      alertas,
      comparacao,
      baseCasouPor,
      nfAutorizada,
      itens: p.itens,
      base: docsBase,
    }),
    atualizado_em: Date.now(),
  };
  await store.salvarPedido(pedido);
  await store.log(
    situacao === "sombra_ok" ? "info" : "aviso",
    p.chave,
    `${situacao} — total ${reais(p.totalCentavos)}, comissão ${reais(p.comissaoCentavos)}, frete ${reais(freteCentavos)}` +
      (bloqueio ? ` — ${bloqueio}` : "") +
      (comparacao?.divergencias.length ? ` — ${comparacao.divergencias.join(" | ")}` : ""),
  );
  return pedido;
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
