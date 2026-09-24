// Envio do XML da NF-e (TOP 1130 autorizada) ao Mercado Livre.
//
// Coleta (xd_drop_off, drop_off, cross_docking): POST /shipments/{id}/invoice_data/?siteId=MLB
// com o <nfeProc> cru (application/xml). O envio precisa estar ready_to_ship +
// invoice_pending; depois do upload o ML libera a etiqueta (ready_to_print).
// Flex (self_service): POST /packs/{pack_id}/fiscal_documents (multipart, campo
// fiscal_document) — não mexe no status do envio.
// Full (fulfillment): fiscal é do ML, nada a fazer.
// Doc oficial lida em 24/09/2026: importar-nota-fiscal e anexar-nota-fiscal.
//
// Idempotente: antes de enviar consulta o que o ML já tem; se já houver nota com a
// mesma chave, só registra. Chave diferente nunca é sobrescrita — vira "divergente".

import { meliEnviar, meliGet } from "./meli.ts";
import { consultar, lerXmlNfe } from "./sankhya.ts";
import { storeStub } from "./store.ts";
import { type Env, ErroDefinitivo, ErroTemporario } from "./tipos.ts";
import { validarNfeProc } from "./xml.ts";

const COLETA = new Set(["xd_drop_off", "drop_off", "cross_docking", "xd_same_day"]);
const FINAIS = new Set(["enviado", "ja_no_ml", "nao_se_aplica", "cancelado"]);

interface Envio {
  id: string;
  logistic_type?: string;
  status?: string;
  substatus?: string | null;
}

/** Envio do ML de um pedido: pack → shipment.id; sem pack → order.shipping.id. */
async function envioDoPedido(env: Env, chave: string): Promise<Envio | null> {
  let sid: string | null = null;
  try {
    const pack = await meliGet<{ shipment?: { id?: number | string } }>(env, `/packs/${chave}`);
    sid = pack.shipment?.id ? String(pack.shipment.id) : null;
  } catch (e) {
    if (e instanceof ErroTemporario) throw e;
    const order = await meliGet<{ shipping?: { id?: number | string } }>(env, `/orders/${chave}`);
    sid = order.shipping?.id ? String(order.shipping.id) : null;
  }
  if (!sid) return null;
  const s = await meliGet<Envio>(env, `/shipments/${sid}`);
  return { ...s, id: sid };
}

/** Nota que o ML já tem para o envio (404 = nenhuma). */
async function notaNoMl(env: Env, envio: Envio, chave: string): Promise<string | null> {
  try {
    if (envio.logistic_type === "self_service") {
      const d = await meliGet<any>(env, `/packs/${chave}/fiscal_documents`);
      const docs = Array.isArray(d?.fiscal_documents) ? d.fiscal_documents : Array.isArray(d) ? d : [];
      return docs.length ? String(docs[0]?.fiscal_key ?? docs[0]?.id ?? "anexado") : null;
    }
    const d = await meliGet<{ fiscal_key?: string }>(env, `/shipments/${envio.id}/invoice_data?siteId=MLB`);
    return d.fiscal_key ? String(d.fiscal_key) : null;
  } catch (e) {
    if (e instanceof ErroDefinitivo && /HTTP 404/.test(e.message)) return null;
    throw e;
  }
}

/**
 * Avalia e (se `enviar`) manda o XML de uma NF. Devolve o status gravado.
 * Com enviar=false só atualiza a situação (útil no modo manual).
 */
export async function processarNf(env: Env, chave: string, nunotaNf: number, enviar: boolean): Promise<string> {
  const store = storeStub(env);
  const reg = (status: string, extra: { envio?: Envio | null; fiscal_key?: string | null; detalhe?: string } = {}, tentativa = false) =>
    store.salvarNf(
      {
        chave,
        nunota_nf: nunotaNf,
        shipment_id: extra.envio?.id ?? null,
        logistica: extra.envio?.logistic_type ?? null,
        fiscal_key: extra.fiscal_key ?? null,
        status,
        detalhe: extra.detalhe ?? null,
      },
      tentativa,
    ).then(() => status);

  const envio = await envioDoPedido(env, chave);
  if (!envio) return reg("erro", { detalhe: "pedido sem envio no ML" });
  if (envio.logistic_type === "fulfillment") return reg("nao_se_aplica", { envio, detalhe: "Full: fiscal é do ML" });
  if (envio.status === "cancelled") return reg("cancelado", { envio, detalhe: "envio cancelado no ML" });

  const xml = await lerXmlNfe(env, nunotaNf);
  const info = validarNfeProc(xml);

  const noMl = await notaNoMl(env, envio, chave);
  if (noMl) {
    return noMl === info.chave || noMl === "anexado"
      ? reg("ja_no_ml", { envio, fiscal_key: noMl, detalhe: `NF ${info.numero} já estava no ML` })
      : reg("divergente", { envio, fiscal_key: noMl, detalhe: `ML tem a chave ${noMl}, Sankhya tem ${info.chave} — não sobrescrevo` });
  }

  const flex = envio.logistic_type === "self_service";
  if (!flex && !COLETA.has(envio.logistic_type ?? "")) {
    return reg("erro", { envio, fiscal_key: info.chave, detalhe: `logística ${envio.logistic_type} não suportada` });
  }
  if (!flex && !(envio.status === "ready_to_ship" && envio.substatus === "invoice_pending")) {
    // Ex.: pending/buffered — o ML ainda não pediu a nota. O cron tenta de novo.
    return reg("aguardando_ml", { envio, fiscal_key: info.chave, detalhe: `envio ${envio.status}/${envio.substatus ?? "-"}` });
  }
  if (!enviar) return reg("pronto", { envio, fiscal_key: info.chave, detalhe: `NF ${info.numero} pronta para enviar` });

  const trava = `nf:${chave}`;
  if (!(await store.travar(trava, 2 * 60_000))) throw new ErroTemporario(`envio da NF de ${chave} já em andamento`);
  try {
    let r: { status: number; corpo: any };
    if (flex) {
      const form = new FormData();
      form.append("fiscal_document", new Blob([xml], { type: "application/xml" }), `nfe-${info.chave}.xml`);
      r = await meliEnviar(env, "POST", `/packs/${chave}/fiscal_documents`, form);
    } else {
      r = await meliEnviar(env, "POST", `/shipments/${envio.id}/invoice_data/?siteId=MLB`, xml, "application/xml");
    }
    // Confirma pelo que o ML passou a ter — vale mais que o corpo da resposta.
    const depois = await notaNoMl(env, envio, chave);
    if (depois === info.chave || (flex && depois)) {
      await store.log("info", chave, `XML da NF ${info.numero} (NUNOTA ${nunotaNf}) enviado ao ML — envio ${envio.id}`);
      return reg("enviado", { envio, fiscal_key: info.chave, detalhe: `HTTP ${r.status}` }, true);
    }
    const msg = `ML respondeu HTTP ${r.status}: ${JSON.stringify(r.corpo).slice(0, 300)}`;
    await store.log("erro", chave, `XML da NF ${info.numero} não aceito — ${msg}`);
    return reg("erro", { envio, fiscal_key: info.chave, detalhe: msg }, true);
  } finally {
    await store.destravar(trava);
  }
}

/**
 * Varre as NFs 1130 autorizadas dos últimos dias com número do ML na observação
 * e processa as que ainda não terminaram. Chamado pelo cron e pelo painel.
 */
export async function varrerNfs(env: Env, enviar: boolean, dias = 3, limite = 5): Promise<{ vistas: number; processadas: number }> {
  // limite por execução: cada NF custa ~7 subrequests (ML + Sankhya) e o Worker
  // tem teto de subrequests por invocação. As que sobrarem vão na próxima rodada.
  const store = storeStub(env);
  const notas = await consultar(
    env,
    `SELECT NUNOTA, SUBSTR(TRIM(OBSERVACAO), 1, 16) CHAVE FROM TGFCAB
     WHERE CODTIPOPER = 1130 AND STATUSNFE = 'A' AND DTNEG >= TRUNC(SYSDATE) - ${Math.max(1, Math.min(30, dias))}
       AND REGEXP_LIKE(TRIM(OBSERVACAO), '^[0-9]{16}') ORDER BY NUNOTA DESC`, // mais novas primeiro
  );
  let processadas = 0;
  for (const n of notas) {
    if (processadas >= limite) break;
    const chave = String(n.CHAVE);
    const atual = await store.nf(chave);
    if (atual && FINAIS.has(atual.status)) continue;
    if (atual && atual.status === "erro" && atual.tentativas >= 5) continue; // espera ação humana
    try {
      await processarNf(env, chave, Number(n.NUNOTA), enviar);
    } catch (e) {
      await store.salvarNf(
        { chave, nunota_nf: Number(n.NUNOTA), shipment_id: atual?.shipment_id ?? null, logistica: atual?.logistica ?? null,
          fiscal_key: atual?.fiscal_key ?? null, status: "erro", detalhe: (e as Error).message },
        true,
      );
    }
    processadas++;
  }
  return { vistas: notas.length, processadas };
}
