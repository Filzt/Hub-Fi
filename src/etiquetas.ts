// Etiquetas de envio (Mercado Envios 2) para impressão em lote.
//
// A etiqueta é a do próprio ML (10x15, layout não personalizável). Depois que o XML
// da NF foi aceito (invoice_data), o ML já imprime nela número, série, emissão e o
// código de barras da chave de acesso — confirmado pela etiqueta real que a Base
// imprimia (24/09/2026). Então aqui só baixamos: GET /shipment_labels, até 50 envios
// por chamada, response_type=pdf ou zpl2 (doc "Mercado Envios 2", lida em 24/09/2026).
// Imprimível: status ready_to_ship com substatus ready_to_print ou printed.
// Baixar a etiqueta costuma marcar o envio como "printed" no ML.

import { meliBaixar, meliGet } from "./meli.ts";
import { storeStub } from "./store.ts";
import { type Env, ErroDefinitivo } from "./tipos.ts";

type Shipment = {
  id: number | string;
  status?: string;
  substatus?: string | null;
  logistic_type?: string;
  order_id?: number | string | null;
  pack_id?: number | string | null;
};

/** Relê um envio no ML e grava a situação (usado pelo webhook "shipments" e pela atualização manual). */
export async function atualizarEnvio(env: Env, shipmentId: string): Promise<void> {
  if (!/^\d{6,20}$/.test(shipmentId)) throw new ErroDefinitivo(`shipment_id inválido: ${shipmentId}`);
  const s = await meliGet<Shipment>(env, `/shipments/${shipmentId}`);
  await storeStub(env).salvarEnvio({
    shipment_id: String(s.id ?? shipmentId),
    chave: s.pack_id ? String(s.pack_id) : s.order_id ? String(s.order_id) : null,
    status: s.status ?? "",
    substatus: s.substatus ?? "",
    logistica: s.logistic_type ?? "",
  });
}

/** Atualiza os envios das NFs conhecidas que ainda não saíram (até `limite` por chamada). */
export async function atualizarEnviosPendentes(env: Env, limite = 20): Promise<number> {
  const ids = await storeStub(env).enviosParaAtualizar(limite);
  for (const id of ids) await atualizarEnvio(env, id);
  return ids.length;
}

/** Baixa as etiquetas (PDF ou ZPL) de até 50 envios de uma vez. */
export async function baixarEtiquetas(env: Env, ids: string[], formato: "pdf" | "zpl2"): Promise<Response> {
  const limpos = [...new Set(ids.map((x) => x.trim()).filter((x) => /^\d{6,20}$/.test(x)))];
  if (!limpos.length) throw new ErroDefinitivo("nenhum envio válido");
  if (limpos.length > 50) throw new ErroDefinitivo("máximo de 50 envios por impressão (limite do ML)");
  const r = await meliBaixar(env, `/shipment_labels?shipment_ids=${limpos.join(",")}&response_type=${formato}`);
  if (r.status !== 200) {
    throw new ErroDefinitivo(`ML recusou as etiquetas (HTTP ${r.status}): ${new TextDecoder().decode(r.corpo).slice(0, 300)}`);
  }
  const store = storeStub(env);
  await store.marcarImpressos(limpos);
  await store.log("info", null, `etiquetas baixadas (${formato}): ${limpos.join(", ")}`);
  const ext = formato === "pdf" ? "pdf" : "zpl";
  return new Response(r.corpo, {
    headers: {
      "Content-Type": r.contentType || (formato === "pdf" ? "application/pdf" : "text/plain"),
      "Content-Disposition": `attachment; filename="etiquetas-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.${ext}"`,
      "Cache-Control": "no-store",
    },
  });
}
