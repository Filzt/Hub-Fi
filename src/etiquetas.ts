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
import { juntarEtiquetas } from "./recorte.ts";
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

// PDF: um envio por chamada ao ML, para cada etiqueta vir sozinha na página e o
// recorte 10x15 (recorte.ts) valer. Teto de 20 por impressão para ficar longe do
// limite de subrequests do Worker. ZPL já sai no tamanho da etiqueta e vai em lote.
const MAX_PDF = 20;

/** Baixa as etiquetas: PDF recortado em 10x15 (até 20) ou ZPL (até 50). */
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
  let corpo: Uint8Array;
  let tipo: string;
  if (formato === "pdf") {
    const pdfs: Uint8Array[] = [];
    for (const id of limpos) pdfs.push(new Uint8Array((await baixar([id])).corpo));
    const { pdf, foraDoPadrao } = await juntarEtiquetas(pdfs);
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
