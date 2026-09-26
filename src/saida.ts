// Saída fixa para o Sankhya (26/09/2026).
//
// A partir de 26/09/2026 09:34 o gateway do Sankhya passou a responder 401 "Unauthorized" no
// /authenticate quando a chamada sai de alguns datacenters do Cloudflare. Visto saindo de Mumbai
// (BOM); de São Paulo (GRU) funciona com as mesmas chaves. A rodada agendada (cron) roda em
// qualquer datacenter; o posicionamento do Worker ("placement" no wrangler.toml, perto de
// aws:sa-east-1) só vale para o handler fetch. Doc lida direto em 26/09/2026:
// "Placement only affects the execution of fetch event handlers."
//
// Por isso toda chamada ao Sankhya passa pela rota interna /interno/sankhya, chamada pelo próprio
// Worker via service binding (SELF). Essa rota roda no handler fetch, portanto posicionada perto
// de São Paulo, e só encaminha para env.SANKHYA_API (/authenticate e /gateway/v1/...).
// Sem o binding SELF (teste local), chama direto.

import { TIMEOUT_MS } from "./config.ts";
import type { Env } from "./tipos.ts";

export const ROTA_SAIDA = "/interno/sankhya";
const DESTINO_VALIDO = /^\/(authenticate$|gateway\/v1\/)/;
const ORIGEM = "/__origem";

/** Chave da rota interna, derivada de um secret que já existe: não precisa de secret novo. */
async function chaveInterna(env: Env): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`skyhub-saida:${env.SANKHYA_CLIENT_SECRET}`));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function chaveConfere(recebida: string, env: Env): Promise<boolean> {
  if (!recebida || !env.SANKHYA_CLIENT_SECRET) return false;
  const h = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([h(recebida), h(await chaveInterna(env))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** fetch ao Sankhya pela saída fixa. `url` precisa começar com env.SANKHYA_API. */
export async function sankhyaFetch(env: Env, url: string, init: RequestInit): Promise<Response> {
  if (!env.SELF) return fetch(url, init);
  const alvo = new URL(url);
  const headers = new Headers(init.headers);
  headers.set("x-skyhub-interno", await chaveInterna(env));
  headers.set("x-skyhub-destino", alvo.pathname + alvo.search);
  return env.SELF.fetch(`https://skyhub.interno${ROTA_SAIDA}`, { method: init.method ?? "GET", headers, body: init.body, signal: init.signal });
}

/** Datacenter de onde a saída fixa fala com o mundo, ex. "GRU/BR". Para diagnóstico. */
export async function origemDaSaida(env: Env): Promise<string> {
  const r = await sankhyaFetch(env, `${env.SANKHYA_API}${ORIGEM}`, { method: "GET", signal: AbortSignal.timeout(5000) });
  return r.ok ? await r.text() : `HTTP ${r.status}`;
}

/** Datacenter desta execução, lido do trace do Cloudflare. */
export async function origemLocal(): Promise<string> {
  return fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(3000) })
    .then((t) => t.text())
    .then((t) => ["colo", "loc"].map((k) => t.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "?").join("/"))
    .catch(() => "?");
}

/** Handler da rota interna. Qualquer coisa fora do combinado vira 404, sem dizer por quê. */
export async function atenderSaida(req: Request, env: Env): Promise<Response> {
  const nao = () => new Response("não encontrado", { status: 404 });
  if (!(await chaveConfere(req.headers.get("x-skyhub-interno") ?? "", env))) return nao();
  const destino = req.headers.get("x-skyhub-destino") ?? "";
  if (destino === ORIGEM) return new Response(await origemLocal());
  if (!DESTINO_VALIDO.test(destino.split("?")[0])) return nao();
  const headers = new Headers(req.headers);
  for (const h of ["x-skyhub-interno", "x-skyhub-destino", "host", "cf-connecting-ip", "x-forwarded-for"]) headers.delete(h);
  const temCorpo = req.method !== "GET" && req.method !== "HEAD";
  return fetch(`${env.SANKHYA_API}${destino}`, {
    method: req.method,
    headers,
    body: temCorpo ? await req.arrayBuffer() : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS.sankhyaEscrita),
  });
}
