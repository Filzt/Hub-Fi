// Cliente do Sankhya da Skyline via gateway (api.sankhya.com.br).
// SOMENTE LEITURA nesta fase: consultar() recusa tudo que não for SELECT.
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
