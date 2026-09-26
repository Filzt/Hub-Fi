// Login do painel pelo Supabase Auth + funções (papéis) do SkyHub.
//
// - As pessoas entram com e-mail e senha no Supabase (supabase-js no navegador). O
//   Worker recebe o access token (JWT ES256) e confere a assinatura pela JWKS do
//   projeto, sem chamar o Supabase a cada requisição (JWKS conferida em 25/09/2026:
//   uma chave EC P-256, ES256).
// - Quem pode o quê fica no Store (tabelas funcoes e usuarios): ter conta no Supabase
//   NÃO dá acesso — o cadastro público do Supabase estava ligado em 25/09/2026. Só entra
//   quem um administrador cadastrou no SkyHub (ou o e-mail de ADMIN_INICIAL, 1ª vez).
// - O ADMIN_TOKEN continua valendo para scripts (ex.: ml_api.py pega o token do ML).

import type { Env } from "./tipos.ts";

export const MODULOS = ["pedidos", "expedicao", "produtos", "publicacao", "precificacao", "integracao"] as const;
export type Modulo = (typeof MODULOS)[number];

export interface Quem {
  tipo: "sistema" | "scripts" | "usuario";
  id: string; // sub do JWT ou "sistema"
  email: string;
  nome: string;
  funcao: string | null;
  admin: boolean;
  modulos: Modulo[];
}

// --------------------------------------------------------------------- JWT (ES256)

let jwks: { em: number; chaves: Map<string, CryptoKey> } | null = null;

async function chavesPublicas(env: Env, forcar = false): Promise<Map<string, CryptoKey>> {
  if (!forcar && jwks && Date.now() - jwks.em < 10 * 60_000) return jwks.chaves;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`JWKS do Supabase: HTTP ${r.status}`);
  const { keys } = (await r.json()) as { keys: Array<JsonWebKey & { kid?: string; alg?: string }> };
  const chaves = new Map<string, CryptoKey>();
  for (const k of keys ?? []) {
    if (k.kty !== "EC" || k.crv !== "P-256" || !k.kid) continue;
    chaves.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]));
  }
  jwks = { em: Date.now(), chaves };
  return chaves;
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export interface Claims {
  sub: string; email?: string; exp: number; iss?: string; aud?: string | string[]; role?: string;
  amr?: Array<{ method?: string; timestamp?: number }>; // Supabase: como e quando a sessão foi autenticada
}

/**
 * A pessoa digitou a senha há pouco? (amr "password" dentro da janela). Trocar o e-mail muda
 * o login: exige senha recente, para que uma sessão esquecida aberta não baste.
 */
export function senhaRecente(c: Pick<Claims, "amr">, agoraS: number, janelaS = 5 * 60): boolean {
  return (c.amr ?? []).some((a) => a.method === "password" && typeof a.timestamp === "number" && agoraS - a.timestamp <= janelaS && a.timestamp <= agoraS + 60);
}

/** E-mail aceitável para login (simples, sem espaço; o Supabase valida o resto). */
export const emailValido = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;

/** Confere assinatura, emissor, público e validade. Null se qualquer coisa falhar. */
export async function verificarJwt(env: Env, token: string): Promise<Claims | null> {
  const partes = token.split(".");
  if (partes.length !== 3) return null;
  let cab: { alg?: string; kid?: string };
  let claims: Claims;
  try {
    cab = JSON.parse(new TextDecoder().decode(b64url(partes[0])));
    claims = JSON.parse(new TextDecoder().decode(b64url(partes[1])));
  } catch { return null; }
  if (cab.alg !== "ES256" || !cab.kid) return null;
  let chave = (await chavesPublicas(env)).get(cab.kid);
  if (!chave) chave = (await chavesPublicas(env, true)).get(cab.kid); // rotação de chave
  if (!chave) return null;
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, chave, b64url(partes[2]), new TextEncoder().encode(`${partes[0]}.${partes[1]}`));
  if (!ok) return null;
  const agora = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!claims.sub || !claims.exp || claims.exp < agora) return null;
  if (claims.iss !== `${env.SUPABASE_URL}/auth/v1` || !aud.includes("authenticated")) return null;
  return claims;
}

// --------------------------------------------------------------------- permissões

/**
 * Módulo exigido por cada rota da API. Rota que não está aqui é só de administrador
 * (negar por padrão). null = qualquer usuário logado.
 */
export function moduloDaRota(metodo: string, p: string): Modulo | "admin" | "sistema" | null {
  if (p === "/api/eu") return null;
  if (p === "/api/meli/access-token" || p === "/api/meli/semear") return "sistema"; // só scripts
  if (p.startsWith("/api/admin/")) return "admin";
  if (p === "/api/fluxo" || p.startsWith("/api/pedidos") || p.startsWith("/api/notas/")) return "pedidos";
  if (p.startsWith("/api/etiquetas") || p.startsWith("/api/expedicao/")) return "expedicao";
  if (p === "/api/produtos" || p.startsWith("/api/estoque")) return "produtos";
  if (p.startsWith("/api/reguas")) return "precificacao";
  if (p === "/api/publicacao/fichas/importar") return "admin";
  if (p.startsWith("/api/publicacao/") || p.startsWith("/api/flex")) return "publicacao"; // Flex: anúncios do ML
  if (p === "/api/integracao" || p === "/api/integracao/origem" || p === "/api/saude" || p.startsWith("/api/nfs") || p.startsWith("/api/eventos") ||
      p === "/api/log" || p === "/api/meli/status") return "integracao";
  void metodo;
  return "admin";
}

export function pode(quem: Quem, exigido: Modulo | "admin" | "sistema" | null): boolean {
  // Token dos scripts: só o token do ML. ADMIN_TOKEN: tudo, MENOS o token do ML (auditoria F2).
  if (quem.tipo === "scripts") return exigido === "sistema";
  if (quem.tipo === "sistema") return exigido !== "sistema";
  if (exigido === null) return true;
  if (exigido === "sistema") return false;
  if (quem.admin) return true;
  if (exigido === "admin") return false;
  return quem.modulos.includes(exigido);
}

/** Id de função a partir do nome: "Expedição Manhã" → "expedicao-manha". */
export function idDaFuncao(nome: string): string {
  return nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

// --------------------------------------------------------------------- Supabase Admin

/** Chamada à API de administração do Auth com a chave secreta (só no Worker). */
export async function supabaseAdmin<T = unknown>(env: Env, metodo: string, caminho: string, corpo?: unknown): Promise<T> {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1${caminho}`, {
    method: metodo,
    headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`, "Content-Type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    signal: AbortSignal.timeout(15000),
  });
  const txt = await r.text();
  if (!r.ok) {
    let msg = txt.slice(0, 300);
    try { const d = JSON.parse(txt); msg = d.msg || d.message || d.error_description || d.error || msg; } catch { /* texto cru */ }
    throw new Error(`Supabase ${metodo} ${caminho.split("?")[0]}: HTTP ${r.status} — ${msg}`);
  }
  return (txt ? JSON.parse(txt) : null) as T;
}

/**
 * Link para a pessoa definir a senha (sem depender do e-mail do Supabase, que só
 * envia para a equipe e 2 por hora — doc "Send emails with custom SMTP", lida em
 * 25/09/2026). O administrador copia e manda pelo WhatsApp.
 */
export async function linkDeSenha(env: Env, email: string, redirecionar: string): Promise<string> {
  const d = await supabaseAdmin<{ action_link?: string; properties?: { action_link?: string } }>(
    env, "POST", "/admin/generate_link", { type: "recovery", email, redirect_to: redirecionar },
  );
  const link = d?.properties?.action_link ?? d?.action_link;
  if (!link) throw new Error("Supabase não devolveu o link de senha");
  return link;
}
