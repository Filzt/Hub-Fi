// Cliente do Sankhya da Skyline via gateway (api.sankhya.com.br).
//   consultar()       — leitura; recusa tudo que não for SELECT.
//   salvarParceiro()  — DatasetSP.save (entidade Parceiro).
//   incluirNota()     — CACSP.incluirNota (módulo mgecom).
// As duas escritas só são chamadas por processamento.gravarPedido, que exige
// MODO "manual" ou "automatico".
//
// Contrato confirmado em 24/09/2026 com as credenciais SANKHYA_SKYLINE_* do cofre:
//   POST {api}/authenticate  (form: client_id, client_secret, grant_type=client_credentials; header X-Token)
//   POST {api}/gateway/v1/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json
// O gateway responde HTTP 200 mesmo em erro de negócio: quem decide é o campo status.

import { TIMEOUT_MS } from "./config.ts";
import { type Env, ErroDefinitivo, ErroTemporario } from "./tipos.ts";

let cache: { token: string; expira: number } | null = null;

// O gateway recusa duas chamadas simultâneas com o mesmo token ("O serviço foi cancelado
// por situação de concorrência. Essa mesma sessão HTTP fez a requisição duas vezes
// simultaneamente" — visto em 24/09/2026 com webhook e cron rodando juntos). Todas as
// chamadas deste isolate passam por esta fila, uma de cada vez.
let fila: Promise<unknown> = Promise.resolve();
function emFila<T>(fn: () => Promise<T>): Promise<T> {
  const vez = fila.then(fn, fn);
  fila = vez.catch(() => undefined);
  return vez;
}
const concorrencia = (m: string) => /concorr[eê]ncia|duas vezes simultaneamente/i.test(m);
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function token(env: Env): Promise<string> {
  if (cache && cache.expira > Date.now()) return cache.token;
  let r: Response;
  try {
    r = await fetch(`${env.SANKHYA_API}/authenticate`, {
      method: "POST",
      headers: { "X-Token": env.SANKHYA_XTOKEN, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.SANKHYA_CLIENT_ID,
        client_secret: env.SANKHYA_CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS.sankhya),
    });
  } catch (e) {
    throw new ErroTemporario(`Sankhya authenticate: falha de rede (${(e as Error).message})`);
  }
  if (!r.ok) {
    const msg = `Sankhya authenticate: HTTP ${r.status}`;
    throw r.status >= 500 ? new ErroTemporario(msg) : new ErroDefinitivo(msg);
  }
  const d = (await r.json()) as Record<string, unknown>;
  const t = d.access_token ?? d.accessToken ?? d.bearerToken ?? d.token;
  if (!t) throw new ErroDefinitivo(`Sankhya authenticate: token ausente (campos: ${Object.keys(d)})`);
  // Sem expires_in confiável, renova com folga a cada 4 min.
  const ttl = Math.max(60, Number(d.expires_in ?? 300) - 60) * 1000;
  cache = { token: String(t), expira: Date.now() + Math.min(ttl, 4 * 60_000) };
  return cache.token;
}

export type Linha = Record<string, unknown>;

/** Executa um SELECT e devolve as linhas como objetos {COLUNA: valor}. */
export async function consultar(env: Env, sql: string): Promise<Linha[]> {
  if (!/^\s*SELECT\s/i.test(sql)) throw new ErroDefinitivo("sankhya.consultar só executa SELECT");
  for (let t = 0; ; t++) {
    try {
      return await emFila(() => consultarUmaVez(env, sql));
    } catch (e) {
      if (t < 2 && e instanceof ErroTemporario && concorrencia(e.message)) { await esperar(400 + Math.random() * 600); continue; }
      throw e;
    }
  }
}

async function consultarUmaVez(env: Env, sql: string): Promise<Linha[]> {
  let r: Response;
  try {
    r = await fetch(
      `${env.SANKHYA_API}/gateway/v1/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${await token(env)}`, "Content-Type": "application/json" },
        body: JSON.stringify({ serviceName: "DbExplorerSP.executeQuery", requestBody: { sql } }),
        signal: AbortSignal.timeout(TIMEOUT_MS.sankhya),
      },
    );
  } catch (e) {
    throw new ErroTemporario(`Sankhya executeQuery: falha de rede (${(e as Error).message})`);
  }
  if (r.status === 401) cache = null;
  if (r.status >= 500 || r.status === 401 || r.status === 429) {
    throw new ErroTemporario(`Sankhya executeQuery: HTTP ${r.status}`);
  }
  const d = (await r.json().catch(() => null)) as
    | { status?: string; statusMessage?: string; responseBody?: { fieldsMetadata?: { name: string }[]; rows?: unknown[][] } }
    | null;
  if (!d) throw new ErroTemporario(`Sankhya executeQuery: resposta não-JSON (HTTP ${r.status})`);
  if (String(d.status) !== "1") {
    const msg = `Sankhya: ${d.statusMessage ?? "erro sem mensagem"}`;
    // status 3/4 (timeout, concorrência) não executou nada: vale tentar de novo.
    if (String(d.status) === "3" || String(d.status) === "4" || concorrencia(msg)) throw new ErroTemporario(msg);
    throw new ErroDefinitivo(msg);
  }
  const cols = (d.responseBody?.fieldsMetadata ?? []).map((c) => c.name);
  const linhas = d.responseBody?.rows ?? [];
  // O DbExplorer corta em 5.000 linhas sem avisar: consultas aqui são pontuais.
  if (linhas.length >= 5000) throw new ErroDefinitivo("Sankhya: consulta bateu o teto de 5.000 linhas");
  return linhas.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

// ---------------------------------------------------------------------------
// Escrita
// Doc oficial lida em 24/09/2026 (developer.sankhya.com.br):
//   - status "1" sucesso, "0" erro, "3" timeout, "4" cancelado por concorrência;
//     erro de negócio volta com HTTP 200 e mensagem em statusMessage;
//   - CACSP.incluirNota é exclusivo do módulo mgecom; NUNOTA em responseBody.pk.NUNOTA.$;
//   - DatasetSP.save (mge) com entityName "Parceiro"; CODPARC novo em responseBody.result[0][0].
// ---------------------------------------------------------------------------

type Envelope = { status?: string; statusMessage?: string; responseBody?: any };

/** Mensagem legível: algumas instâncias devolvem statusMessage em base64. */
function mensagem(d: Envelope): string {
  const m = String(d.statusMessage ?? "erro sem mensagem");
  if (/^[A-Za-z0-9+/=\s]{16,}$/.test(m)) {
    try {
      const txt = new TextDecoder().decode(Uint8Array.from(atob(m.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
      if (/^[\x20-\x7E\u00A0-\u017F\s]+$/.test(txt)) return txt;
    } catch { /* não era base64 */ }
  }
  return m;
}

async function servico(env: Env, modulo: "mge" | "mgecom", serviceName: string, requestBody: unknown): Promise<any> {
  for (let t = 0; ; t++) {
    try {
      return await emFila(() => servicoUmaVez(env, modulo, serviceName, requestBody));
    } catch (e) {
      if (t < 2 && e instanceof ErroTemporario && concorrencia(e.message)) { await esperar(400 + Math.random() * 600); continue; }
      throw e;
    }
  }
}

async function servicoUmaVez(env: Env, modulo: "mge" | "mgecom", serviceName: string, requestBody: unknown): Promise<any> {
  let r: Response;
  try {
    r = await fetch(`${env.SANKHYA_API}/gateway/v1/${modulo}/service.sbr?serviceName=${serviceName}&outputType=json`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token(env)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ serviceName, requestBody }),
      signal: AbortSignal.timeout(TIMEOUT_MS.sankhyaEscrita),
    });
  } catch (e) {
    // Timeout depois de enviado é ambíguo: o chamador confere se gravou antes de repetir.
    throw new ErroTemporario(`Sankhya ${serviceName}: falha de rede/timeout (${(e as Error).message})`);
  }
  if (r.status === 401 || r.status === 403) cache = null;
  if (r.status >= 500 || r.status === 401 || r.status === 403 || r.status === 429) {
    throw new ErroTemporario(`Sankhya ${serviceName}: HTTP ${r.status}`);
  }
  const d = (await r.json().catch(() => null)) as Envelope | null;
  if (!d) throw new ErroTemporario(`Sankhya ${serviceName}: resposta não-JSON (HTTP ${r.status})`);
  const st = String(d.status);
  if (st === "3" || st === "4" || concorrencia(mensagem(d))) throw new ErroTemporario(`Sankhya ${serviceName}: status ${st} — ${mensagem(d)}`);
  if (st !== "1") throw new ErroDefinitivo(`Sankhya ${serviceName}: ${mensagem(d)}`);
  return d.responseBody ?? {};
}

/** Cria um parceiro. Devolve o CODPARC se a resposta trouxer (o chamador confirma lendo). */
export async function salvarParceiro(env: Env, campos: Record<string, string>): Promise<number | null> {
  const nomes = Object.keys(campos).filter((k) => k !== "CODPARC");
  // CODPARC vai como 1º campo e sem valor: o Sankhya gera e devolve em result[0][0].
  const values = Object.fromEntries(nomes.map((k, i) => [String(i + 1), campos[k]]));
  const rb = await servico(env, "mge", "DatasetSP.save", {
    entityName: "Parceiro",
    standAlone: false,
    fields: ["CODPARC", ...nomes],
    records: [{ values }],
  });
  const cod = Number(rb?.result?.[0]?.[0]);
  return Number.isFinite(cod) && cod > 0 ? cod : null;
}

/** Inclui o pedido. Devolve o NUNOTA se a resposta trouxer (o chamador confirma lendo). */
export async function incluirNota(env: Env, corpo: { requestBody: unknown }): Promise<number | null> {
  const rb = await servico(env, "mgecom", "CACSP.incluirNota", corpo.requestBody);
  const nunota = Number(rb?.pk?.NUNOTA?.$ ?? rb?.pk?.NUNOTA);
  return Number.isFinite(nunota) && nunota > 0 ? nunota : null;
}

/**
 * Confirma um pedido (STATUSNOTA A → L), como a Base fazia depois de incluir.
 * ATENÇÃO: CACSP.confirmarNota NÃO está na lista oficial de serviços do gateway
 * (conferido em 24/09/2026 — a doc só mostra a confirmação via extensão Java).
 * Por isso o chamador confirma o resultado relendo TGFCAB.STATUSNOTA.
 */
export async function confirmarNota(env: Env, nunota: number): Promise<void> {
  if (!Number.isInteger(nunota) || nunota <= 0) throw new ErroDefinitivo(`NUNOTA inválido: ${nunota}`);
  await servico(env, "mgecom", "CACSP.confirmarNota", {
    nota: { NUNOTA: { $: String(nunota) }, confirmacaoCentralNota: "true", ehPedidoWeb: "false" },
  });
}

/**
 * Cria um logradouro na TSIEND (entidade "Endereco", conferida em TDDINS), como a
 * Base fazia para CEP único de cidade. Devolve o CODEND se vier na resposta.
 */
export async function salvarEndereco(env: Env, nomeend: string, tipo: string | null): Promise<number | null> {
  const campos: Record<string, string> = { NOMEEND: nomeend };
  if (tipo) campos.TIPO = tipo;
  const nomes = Object.keys(campos);
  const rb = await servico(env, "mge", "DatasetSP.save", {
    entityName: "Endereco",
    standAlone: false,
    fields: ["CODEND", ...nomes],
    records: [{ values: Object.fromEntries(nomes.map((k, i) => [String(i + 1), campos[k]])) }],
  });
  const cod = Number(rb?.result?.[0]?.[0]);
  return Number.isFinite(cod) && cod > 0 ? cod : null;
}

/**
 * XML autorizado da NF-e (TGFNFE.XMLENVCLI, CLOB com <nfeProc>, ~8 KB).
 * Lido em fatias de 2.000 caracteres: VARCHAR2 no SQL tem teto de 4.000 bytes e
 * o XML pode ter acento (multibyte).
 */
export async function lerXmlNfe(env: Env, nunota: number): Promise<string> {
  if (!Number.isInteger(nunota) || nunota <= 0) throw new ErroDefinitivo(`NUNOTA inválido: ${nunota}`);
  const tam = await consultar(env, `SELECT DBMS_LOB.GETLENGTH(XMLENVCLI) T FROM TGFNFE WHERE NUNOTA = ${nunota}`);
  const total = Number(tam[0]?.T ?? 0);
  if (!total) throw new ErroDefinitivo(`NF ${nunota} sem XML em TGFNFE.XMLENVCLI`);
  const FATIA = 2000;
  const partes: string[] = [];
  for (let ini = 1; ini <= total; ini += FATIA * 5) {
    const cols = Array.from({ length: 5 }, (_, i) => ini + i * FATIA)
      .filter((p) => p <= total)
      .map((p, i) => `DBMS_LOB.SUBSTR(XMLENVCLI, ${FATIA}, ${p}) P${i}`);
    const r = (await consultar(env, `SELECT ${cols.join(", ")} FROM TGFNFE WHERE NUNOTA = ${nunota}`))[0] ?? {};
    for (let i = 0; i < cols.length; i++) partes.push(String(r[`P${i}`] ?? ""));
  }
  const xml = partes.join("");
  if (xml.length !== total) throw new ErroDefinitivo(`XML da NF ${nunota} lido com ${xml.length} de ${total} caracteres`);
  return xml;
}

/**
 * Cancela um pedido/nota confirmado (CACSP.cancelarNota, mgecom — serviço oficial,
 * doc "Cancelamento de Movimentos" lida em 24/09/2026). O documento sai da TGFCAB
 * e vai para a TGFCAN com a justificativa. validarProcessosWmsEmAndamento=true faz o
 * Sankhya recusar se o WMS já estiver separando. IRREVERSÍVEL.
 */
export async function cancelarNota(env: Env, nunota: number, justificativa: string): Promise<number> {
  if (!Number.isInteger(nunota) || nunota <= 0) throw new ErroDefinitivo(`NUNOTA inválido: ${nunota}`);
  const rb = await servico(env, "mgecom", "CACSP.cancelarNota", {
    notasCanceladas: {
      nunota: [{ $: String(nunota) }],
      justificativa: justificativa.slice(0, 200),
      validarProcessosWmsEmAndamento: "true",
    },
  });
  return Number(rb?.resultadoCancelamento?.totalNotasCanceladas ?? 0);
}
