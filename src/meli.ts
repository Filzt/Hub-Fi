// Cliente da API do Mercado Livre + dono único do token OAuth.
//
// O refresh_token do ML é de USO ÚNICO e rotaciona a cada renovação: se dois
// processos renovarem, o segundo invalida o primeiro e a integração morre.
// Por isso o token vive num Durable Object (instância única "principal") e a
// renovação é serializada por uma promise em memória.

import { DurableObject } from "cloudflare:workers";
import { TIMEOUT_MS } from "./config.ts";
import { type Env, ErroDefinitivo, ErroTemporario } from "./tipos.ts";

interface TokenML {
  access: string;
  refresh: string;
  expiraEm: number; // epoch ms
  renovadoEm: number;
}

const MARGEM_MS = 5 * 60_000; // renova 5 min antes de expirar

export class MeliToken extends DurableObject<Env> {
  private renovando: Promise<string> | null = null;

  async accessToken(): Promise<string> {
    const t = await this.ctx.storage.get<TokenML>("token");
    if (!t) throw new ErroDefinitivo("token do ML não semeado — use POST /api/meli/semear");
    if (t.expiraEm - Date.now() > MARGEM_MS) return t.access;
    return this.renovarSerializado();
  }

  /** Força renovação (ex.: 401 com token ainda "válido" no relógio). */
  async forcarRenovacao(): Promise<string> {
    return this.renovarSerializado();
  }

  /** Recebe o refresh_token inicial e já o troca, validando e persistindo o par novo. */
  async semear(refreshToken: string): Promise<{ expiraEm: number }> {
    await this.trocar(refreshToken);
    const t = (await this.ctx.storage.get<TokenML>("token"))!;
    return { expiraEm: t.expiraEm };
  }

  async status(): Promise<{ semeado: boolean; expiraEm?: number; renovadoEm?: number }> {
    const t = await this.ctx.storage.get<TokenML>("token");
    return t ? { semeado: true, expiraEm: t.expiraEm, renovadoEm: t.renovadoEm } : { semeado: false };
  }

  private renovarSerializado(): Promise<string> {
    if (!this.renovando) {
      this.renovando = (async () => {
        const t = await this.ctx.storage.get<TokenML>("token");
        if (!t) throw new ErroDefinitivo("token do ML não semeado");
        // Outra chamada pode ter renovado enquanto esta esperava.
        if (t.expiraEm - Date.now() > MARGEM_MS && t.renovadoEm > Date.now() - 60_000) return t.access;
        return this.trocar(t.refresh);
      })().finally(() => {
        this.renovando = null;
      });
    }
    return this.renovando;
  }

  private async trocar(refreshToken: string): Promise<string> {
    const corpo = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.env.MELI_CLIENT_ID,
      client_secret: this.env.MELI_CLIENT_SECRET,
      refresh_token: refreshToken,
    });
    let r: Response;
    try {
      r = await fetch(`${this.env.MELI_API}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: corpo,
        signal: AbortSignal.timeout(TIMEOUT_MS.meli),
      });
    } catch (e) {
      throw new ErroTemporario(`renovação do token ML: falha de rede (${(e as Error).message})`);
    }
    const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || !d.access_token || !d.refresh_token) {
      // Nunca loga token; só status e código de erro do ML.
      const msg = `renovação do token ML recusada: HTTP ${r.status} ${String(d.error ?? "")}`;
      throw r.status >= 500 ? new ErroTemporario(msg) : new ErroDefinitivo(msg);
    }
    const novo: TokenML = {
      access: String(d.access_token),
      refresh: String(d.refresh_token),
      expiraEm: Date.now() + Number(d.expires_in ?? 21600) * 1000,
      renovadoEm: Date.now(),
    };
    // Persistir ANTES de devolver: o refresh antigo já morreu no ML.
    await this.ctx.storage.put("token", novo);
    return novo.access;
  }
}

function tokenStub(env: Env) {
  return env.MELI_TOKEN.get(env.MELI_TOKEN.idFromName("principal"));
}

/** GET autenticado na API do ML. 5xx/429/rede = temporário; 4xx = definitivo. */
export async function meliGet<T = unknown>(
  env: Env,
  caminho: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const stub = tokenStub(env);
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    let token: string;
    try {
      token = tentativa === 0 ? await stub.accessToken() : await stub.forcarRenovacao();
    } catch (e) {
      // A classe do erro não atravessa o RPC do Durable Object: reclassifica pela mensagem.
      const msg = (e as Error).message;
      if (/não semeado|recusada: HTTP 4/.test(msg)) throw new ErroDefinitivo(msg);
      throw new ErroTemporario(msg);
    }
    let r: Response;
    try {
      r = await fetch(`${env.MELI_API}${caminho}`, {
        headers: { Authorization: `Bearer ${token}`, accept: "application/json", ...headers },
        signal: AbortSignal.timeout(TIMEOUT_MS.meli),
      });
    } catch (e) {
      throw new ErroTemporario(`ML ${caminho}: falha de rede/timeout (${(e as Error).message})`);
    }
    if (r.status === 401 && tentativa === 0) continue; // token rejeitado: renova 1 vez
    if (r.ok) return (await r.json()) as T;

    const corpo = (await r.text()).slice(0, 300);
    const msg = `ML ${caminho}: HTTP ${r.status} ${corpo}`;
    if (r.status === 429 || r.status >= 500) throw new ErroTemporario(msg);
    if (r.status === 403 && corpo.includes("PA_UNAUTHORIZED")) {
      throw new ErroDefinitivo(`${msg} — app do ML sem permissão para este recurso (DevCenter)`);
    }
    throw new ErroDefinitivo(msg);
  }
  throw new ErroDefinitivo(`ML ${caminho}: 401 mesmo após renovar o token`);
}

export { tokenStub };

/**
 * POST/PUT autenticado com corpo arbitrário (XML, multipart). Devolve status e
 * corpo sem lançar em 4xx: quem chama decide (ex.: 4xx de "já existe nota").
 * 5xx/429/rede lançam ErroTemporario.
 */
export async function meliEnviar(
  env: Env,
  metodo: "POST" | "PUT",
  caminho: string,
  corpo: BodyInit,
  contentType?: string,
): Promise<{ status: number; corpo: any }> {
  const stub = tokenStub(env);
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    let token: string;
    try {
      token = tentativa === 0 ? await stub.accessToken() : await stub.forcarRenovacao();
    } catch (e) {
      const msg = (e as Error).message;
      if (/não semeado|recusada: HTTP 4/.test(msg)) throw new ErroDefinitivo(msg);
      throw new ErroTemporario(msg);
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, accept: "application/json" };
    if (contentType) headers["Content-Type"] = contentType; // multipart: o fetch define o boundary
    let r: Response;
    try {
      r = await fetch(`${env.MELI_API}${caminho}`, { method: metodo, headers, body: corpo, signal: AbortSignal.timeout(TIMEOUT_MS.meli * 2) });
    } catch (e) {
      throw new ErroTemporario(`ML ${metodo} ${caminho}: falha de rede/timeout (${(e as Error).message})`);
    }
    if (r.status === 401 && tentativa === 0) continue;
    const texto = await r.text();
    let json: any = texto;
    try { json = JSON.parse(texto); } catch { /* corpo não-JSON */ }
    if (r.status === 429 || r.status >= 500) throw new ErroTemporario(`ML ${metodo} ${caminho}: HTTP ${r.status} ${texto.slice(0, 200)}`);
    return { status: r.status, corpo: json };
  }
  throw new ErroDefinitivo(`ML ${metodo} ${caminho}: 401 mesmo após renovar o token`);
}
