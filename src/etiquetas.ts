// Etiquetas de envio (Mercado Envios 2) para impressão em lote.
//
// A etiqueta é a do próprio ML (10x15, layout não personalizável). Depois que o XML
// da NF foi aceito (invoice_data), o ML já imprime nela número, série, emissão e o
// código de barras da chave de acesso — confirmado pela etiqueta real que a Base
// imprimia (24/09/2026). Então aqui só baixamos: GET /shipment_labels, até 50 envios
// por chamada, response_type=pdf ou zpl2 (doc "Mercado Envios 2", lida em 24/09/2026).
// Imprimível: status ready_to_ship com substatus ready_to_print ou printed.
// Baixar a etiqueta costuma marcar o envio como "printed" no ML.

import { despachoDoEnvio } from "./despacho.ts";
import { checarBipe } from "./expedicao.ts";
import { meliBaixar, meliGet } from "./meli.ts";
import { sqlTexto } from "./nota.ts";
import { type FaixaNf, formatarEmissao, juntarEtiquetas } from "./recorte.ts";
import { consultar } from "./sankhya.ts";
import { storeStub } from "./store.ts";
import { type Env, ErroDefinitivo } from "./tipos.ts";

type Shipment = {
  id: number | string;
  status?: string;
  substatus?: string | null;
  logistic_type?: string;
  order_id?: number | string | null;
  pack_id?: number | string | null;
  status_history?: { date_shipped?: string | null; date_delivered?: string | null } | null;
  substatus_history?: Array<{ date?: string; substatus?: string; status?: string }> | null;
};


/** Relê um envio no ML e grava a situação (usado pelo webhook "shipments" e pela atualização manual). */
export async function atualizarEnvio(env: Env, shipmentId: string): Promise<void> {
  if (!/^\d{6,20}$/.test(shipmentId)) throw new ErroDefinitivo(`shipment_id inválido: ${shipmentId}`);
  const s = await meliGet<Shipment>(env, `/shipments/${shipmentId}`);
  // Agendado (pending/buffered): a data de liberação da etiqueta está em lead_time.buffering
  // (conferido no envio 48099041202 em 25/09/2026: buffering.date = segunda 28/09).
  let liberacao: string | null = null;
  if (s.status === "pending" && s.substatus === "buffered") {
    try {
      const lt = await meliGet<{ buffering?: { date?: string | null } | null }>(env, `/shipments/${shipmentId}/lead_time`);
      liberacao = lt.buffering?.date ?? null;
    } catch { /* sem a data, o envio aparece em Agendados assim mesmo */ }
  }
  await storeStub(env).salvarEnvio({
    shipment_id: String(s.id ?? shipmentId),
    chave: s.pack_id ? String(s.pack_id) : s.order_id ? String(s.order_id) : null,
    status: s.status ?? "",
    substatus: s.substatus ?? "",
    logistica: s.logistic_type ?? "",
    despachado_em: despachoDoEnvio(s),
    liberacao,
  });
}

/** Atualiza os envios das NFs conhecidas que ainda não saíram (até `limite` por chamada). */
export async function atualizarEnviosPendentes(env: Env, limite = 20): Promise<number> {
  const ids = await storeStub(env).enviosParaAtualizar(limite);
  for (const id of ids) await atualizarEnvio(env, id);
  return ids.length;
}

// PDF: um envio por chamada ao ML, para cada etiqueta vir sozinha na página e o
// recorte 10x15 (recorte.ts) valer. Teto de 20 por impressão para ficar longe do
// limite de subrequests do Worker. ZPL já sai no tamanho da etiqueta e vai em lote.
const MAX_PDF = 20;

/** Baixa as etiquetas: PDF recortado em 10x15 (até 20) ou ZPL (até 50). */
/** Situações da NF (tabela nfs) em que o XML já está no ML. */
export const NF_NO_ML = new Set(["enviado", "ja_no_ml"]);

export async function baixarEtiquetas(env: Env, ids: string[], formato: "pdf" | "zpl2"): Promise<Response> {
  const limpos = [...new Set(ids.map((x) => x.trim()).filter((x) => /^\d{6,20}$/.test(x)))];
  if (!limpos.length) throw new ErroDefinitivo("nenhum envio válido");
  if (formato === "zpl2" && limpos.length > 50) throw new ErroDefinitivo("máximo de 50 envios por impressão (limite do ML)");
  if (formato === "pdf" && limpos.length > MAX_PDF) throw new ErroDefinitivo(`máximo de ${MAX_PDF} etiquetas em PDF por impressão`);

  const baixar = async (lista: string[]) => {
    const r = await meliBaixar(env, `/shipment_labels?shipment_ids=${lista.join(",")}&response_type=${formato}`);
    if (r.status !== 200) {
      throw new ErroDefinitivo(`ML recusou a etiqueta ${lista.join(",")} (HTTP ${r.status}): ${new TextDecoder().decode(r.corpo).slice(0, 300)}`);
    }
    return r;
  };

  const store = storeStub(env);
  // Auditoria F7: a checagem de cancelamento não pode morar só no painel. Pela situação que
  // o SkyHub guarda (webhook orders_v2: qualquer order cancelada do pack = "cancelado") e,
  // quando o pedido não está no SkyHub, ao vivo no ML — a mesma checagem do bipe.
  const situacao = await store.pedidosDosEnvios(limpos);
  const conhecidos = new Map(situacao.map((s) => [s.shipment_id, s]));
  const cancelados: string[] = [];
  for (const id of limpos) {
    const s = conhecidos.get(id);
    if (s && s.situacao) {
      if (s.situacao === "cancelado" || s.status_ml === "cancelled" || s.envio_status === "cancelled") cancelados.push(`${id} (pedido ${s.chave})`);
      continue;
    }
    const c = await checarBipe(env, id);
    if (c.cancelado) cancelados.push(`${id} (pedido ${c.pedido ?? "?"}: ${c.motivo})`);
  }
  if (cancelados.length) {
    await store.log("aviso", null, `impressão recusada: venda cancelada — ${cancelados.join(", ")}`);
    throw new ErroDefinitivo(`venda cancelada, não imprima: ${cancelados.join(", ")}`);
  }
  // Flex: o ML libera a etiqueta sem esperar a NF (no xd_drop_off ela fica em invoice_pending).
  // Sem esta trava a caixa sairia sem nota. Só imprime com a NF já anexada no ML (nf.ts).
  const flexSemNf = limpos.filter((id) => {
    const s = conhecidos.get(id);
    return s?.logistica === "self_service" && !(s.fiscal_key && NF_NO_ML.has(String(s.nf_status)));
  });
  if (flexSemNf.length) {
    await store.log("aviso", null, `impressão recusada: Flex sem NF no ML — ${flexSemNf.join(", ")}`);
    throw new ErroDefinitivo(`Flex sem NF: fature e envie a NF ao ML antes de imprimir (${flexSemNf.join(", ")})`);
  }
  let corpo: Uint8Array;
  let tipo: string;
  if (formato === "pdf") {
    // Sem a faixa, a etiqueta ainda serve para despachar: falha no Sankhya não trava a expedição.
    const nfs = await faixasNf(env, limpos).catch(async (e) => {
      await store.log("aviso", null, `faixa da NF indisponível (${(e as Error).message}) — etiquetas sem faixa`);
      return new Map<string, FaixaNf>();
    });
    const itens: Array<{ pdf: Uint8Array; nf: FaixaNf | null }> = [];
    for (const id of limpos) itens.push({ pdf: new Uint8Array((await baixar([id])).corpo), nf: nfs.get(id) ?? null });
    const semNf = limpos.filter((id) => !nfs.has(id));
    if (semNf.length) await store.log("aviso", null, `etiqueta sem faixa da NF (NF autorizada não encontrada): ${semNf.join(", ")}`);
    const { pdf, foraDoPadrao } = await juntarEtiquetas(itens);
    if (foraDoPadrao) await store.log("aviso", null, `${foraDoPadrao} etiqueta(s) fora do layout A4 esperado — saíram sem recorte`);
    corpo = pdf;
    tipo = "application/pdf";
  } else {
    const r = await baixar(limpos);
    corpo = new Uint8Array(r.corpo);
    tipo = r.contentType || "text/plain";
  }
  await store.marcarImpressos(limpos);
  await store.log("info", null, `etiquetas baixadas (${formato}): ${limpos.join(", ")}`);
  const ext = formato === "pdf" ? "pdf" : "zpl";
  return new Response(corpo, {
    headers: {
      "Content-Type": tipo,
      "Content-Disposition": `attachment; filename="etiquetas-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.${ext}"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Dados da NF-e autorizada (TOP 1130) de cada envio, numa consulta só: número, série,
 * chave e dhEmi do XML. O vínculo é o pedido do ML na OBSERVACAO. Com mais de uma NF
 * autorizada no mesmo pedido, vale a que o ML tem (fiscal_key); senão, a mais recente.
 */
async function faixasNf(env: Env, ids: string[]): Promise<Map<string, FaixaNf>> {
  const envios = (await storeStub(env).pedidosDosEnvios(ids)).filter((e) => e.chave && /^\d{6,20}$/.test(e.chave));
  const saida = new Map<string, FaixaNf>();
  if (!envios.length) return saida;
  const linhas = await consultar(
    env,
    `SELECT SUBSTR(C.OBSERVACAO, 1, 16) OBS, C.NUNOTA, C.NUMNOTA, C.SERIENOTA, C.CHAVENFE,
            DBMS_LOB.SUBSTR(N.XMLENVCLI, 25, DBMS_LOB.INSTR(N.XMLENVCLI, '<dhEmi>') + 7) DHEMI
     FROM TGFCAB C LEFT JOIN TGFNFE N ON N.NUNOTA = C.NUNOTA
     WHERE C.CODTIPOPER = 1130 AND C.STATUSNFE = 'A'
       AND SUBSTR(C.OBSERVACAO, 1, 16) IN (${[...new Set(envios.map((e) => sqlTexto(String(e.chave))))].join(",")})
     ORDER BY C.NUNOTA DESC`,
  );
  for (const e of envios) {
    const daVenda = linhas.filter((l) => String(l.OBS) === e.chave && /^\d{44}$/.test(String(l.CHAVENFE ?? "")));
    const nf = daVenda.find((l) => String(l.CHAVENFE) === e.fiscal_key) ?? daVenda[0];
    if (!nf) continue;
    saida.set(e.shipment_id, {
      chave: String(nf.CHAVENFE),
      numero: Number(nf.NUMNOTA),
      serie: String(nf.SERIENOTA ?? "").trim() || "1",
      emissao: formatarEmissao(String(nf.DHEMI ?? "")),
    });
  }
  return saida;
}
