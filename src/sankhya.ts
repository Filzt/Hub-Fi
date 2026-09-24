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
  if (String(d.status) !== "1") throw new ErroDefinitivo(`Sankhya: ${d.statusMessage ?? "erro sem mensagem"}`);
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
  if (st === "3" || st === "4") throw new ErroTemporario(`Sankhya ${serviceName}: status ${st} — ${mensagem(d)}`);
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
