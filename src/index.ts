// skyhub — entrada do Worker: webhook do ML, API do painel e cron de reprocessamento.

import { TOPICOS_ACEITOS } from "./config.ts";
import { tokenStub } from "./meli.ts";
import { PAINEL_HTML } from "./painel.ts";
import { processarEvento, processarPedido } from "./processamento.ts";
import { storeStub } from "./store.ts";
import type { Env } from "./tipos.ts";

export { MeliToken } from "./meli.ts";
export { Store } from "./store.ts";

const json = (dados: unknown, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

/** Comparação em tempo constante do ADMIN_TOKEN (hash dos dois lados). */
async function autorizado(req: Request, env: Env): Promise<boolean> {
  const recebido = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_TOKEN || !recebido) return false;
  const h = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([h(recebido), h(env.ADMIN_TOKEN)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function webhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // O ML exige 200 em até 500 ms, senão desativa o tópico: registra e processa depois.
  // Nunca confia no payload — ele só diz QUAL recurso reler na API.
  let n: { topic?: string; resource?: string; user_id?: number | string; application_id?: number | string };
  try {
    n = await req.json();
  } catch {
    return json({ ok: false, motivo: "json inválido" }, 400);
  }
  const store = storeStub(env);
  const deOutraConta = String(n.user_id ?? "") !== env.MELI_USER_ID;
  const deOutroApp = n.application_id != null && String(n.application_id) !== env.MELI_CLIENT_ID;
  if (!n.topic || !n.resource || !TOPICOS_ACEITOS.has(n.topic) || deOutraConta || deOutroApp) {
    ctx.waitUntil(store.log("aviso", null, `notificação descartada: ${JSON.stringify(n).slice(0, 300)}`));
    return json({ ok: true, ignorado: true }); // 200 para o ML não reenviar lixo
  }
  const id = await store.registrarEvento(n.topic, n.resource);
  ctx.waitUntil(
    (async () => {
      const ev = await store.evento(id);
      if (ev && ev.status === "pendente") await processarEvento(env, ev);
    })(),
  );
  return json({ ok: true });
}

async function rotaApi(req: Request, env: Env, url: URL): Promise<Response> {
  if (!(await autorizado(req, env))) return json({ erro: "não autorizado" }, 401);
  const store = storeStub(env);
  const p = url.pathname;
  const m = (re: RegExp) => p.match(re);

  if (req.method === "GET" && p === "/api/saude") {
    return json({ modo: env.MODO, meli: await tokenStub(env).status(), store: await store.saude() });
  }
  if (req.method === "GET" && p === "/api/pedidos") return json({ pedidos: await store.listarPedidos() });

  let r = m(/^\/api\/pedidos\/(\d+)$/);
  if (req.method === "GET" && r) {
    const pedido = await store.pedido(r[1]);
    return pedido ? json({ pedido }) : json({ erro: "pedido não encontrado" }, 404);
  }
  r = m(/^\/api\/pedidos\/(\d+)\/processar$/);
  if (req.method === "POST" && r) {
    try {
      return json({ pedido: await processarPedido(env, r[1]) });
    } catch (e) {
      await store.log("erro", r[1], `processamento manual: ${(e as Error).message}`);
      return json({ erro: (e as Error).message }, 502);
    }
  }
  if (req.method === "GET" && p === "/api/eventos") {
    return json({ eventos: await store.listarEventos(url.searchParams.get("status")) });
  }
  r = m(/^\/api\/eventos\/(\d+)\/reabrir$/);
  if (req.method === "POST" && r) {
    await store.reabrirEvento(Number(r[1]));
    return json({ ok: true });
  }
  if (req.method === "GET" && p === "/api/log") {
    return json({ log: await store.listarLog(url.searchParams.get("chave")) });
  }

  // Token do ML ------------------------------------------------------------------
  if (req.method === "GET" && p === "/api/meli/status") return json(await tokenStub(env).status());
  if (req.method === "POST" && p === "/api/meli/semear") {
    // ATENÇÃO: consome o refresh_token informado. Quem o usava antes (scripts locais)
    // perde o acesso — daqui em diante o Worker é o único dono do token.
    const corpo = (await req.json().catch(() => ({}))) as { refresh_token?: string };
    if (!corpo.refresh_token) return json({ erro: "informe refresh_token" }, 400);
    try {
      const r2 = await tokenStub(env).semear(corpo.refresh_token);
      await store.log("info", null, "token do ML semeado");
      return json({ ok: true, ...r2 });
    } catch (e) {
      return json({ erro: (e as Error).message }, 502);
    }
  }
  if (req.method === "GET" && p === "/api/meli/access-token") {
    // Para os scripts locais (ml_api.py, vigia de estoque) depois do corte.
    return json({ access_token: await tokenStub(env).accessToken() });
  }
  return json({ erro: "rota não encontrada" }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/ml/webhook" && req.method === "POST") return await webhook(req, env, ctx);
      if (url.pathname === "/config" && req.method === "GET") {
        // Diagnóstico público: só diz QUAIS secrets existem e um prefixo do hash do
        // ADMIN_TOKEN (32 bits de um SHA-256) para conferir com o cofre. Nenhum valor.
        const nomes = ["MELI_CLIENT_ID", "MELI_CLIENT_SECRET", "SANKHYA_CLIENT_ID",
          "SANKHYA_CLIENT_SECRET", "SANKHYA_XTOKEN", "ADMIN_TOKEN"] as const;
        const presentes = Object.fromEntries(nomes.map((n) => [n, Boolean(env[n])]));
        const hash = env.ADMIN_TOKEN
          ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.ADMIN_TOKEN)))]
              .slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("")
          : null;
        return json({ modo: env.MODO, secrets: presentes, adminTokenSha256Prefixo: hash });
      }
      if (url.pathname.startsWith("/api/")) return await rotaApi(req, env, url);
      if (url.pathname === "/" || url.pathname === "/painel") {
        return new Response(PAINEL_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      return json({ erro: "não encontrado" }, 404);
    } catch (e) {
      console.error("erro não tratado", (e as Error).message);
      return json({ erro: "erro interno" }, 500);
    }
  },

  async scheduled(_ev: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const store = storeStub(env);
    const devidos = await store.eventosDevidos();
    for (const ev of devidos) await processarEvento(env, ev); // sequencial: respeita o ML
  },
} satisfies ExportedHandler<Env>;
