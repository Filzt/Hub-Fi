// Vigia: avisa quando para, repete no máximo a cada 30 min, avisa quando volta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verificar } from "../vigia/src/index.ts";

function ambiente(meta: Record<string, string>) {
  const enviados: Array<{ title: string; message: string }> = [];
  const logs: string[] = [];
  const store = {
    meta: async (k: string) => meta[k] ?? null,
    setMeta: async (k: string, v: string) => { meta[k] = v; },
    log: async (_n: string, _c: string | null, m: string) => { logs.push(m); },
  };
  const env = { STORE: { idFromName: () => "id", get: () => store }, NTFY_TOPIC: "canal-teste", PAINEL_URL: "https://x" };
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    assert.equal(b.topic, "canal-teste");
    enviados.push(b);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { env: env as never, enviados, logs, meta };
}

const MIN = 60_000;

test("rodada em dia: não avisa", async () => {
  const t0 = Date.now();
  const a = ambiente({ ultimo_erp_em: String(t0 - 3 * MIN), cron_etapa: `fim:${t0}` });
  assert.equal(await verificar(a.env, t0), "ok");
  assert.equal(a.enviados.length, 0);
});

test("parado: avisa uma vez, repete só depois de 30 min e avisa quando volta", async () => {
  const t0 = Date.now();
  const a = ambiente({ ultimo_erp_em: String(t0 - 15 * MIN), cron_etapa: `nfs:${t0}` });
  await verificar(a.env, t0);
  assert.equal(a.enviados.length, 1);
  assert.equal(a.enviados[0].title, "SkyHub parado");
  assert.match(a.enviados[0].message, /15 min/);
  assert.match(a.enviados[0].message, /Parou na etapa: nfs/);

  await verificar(a.env, t0 + 5 * MIN); // 5 min depois: não repete
  assert.equal(a.enviados.length, 1);
  await verificar(a.env, t0 + 30 * MIN); // 30 min depois: repete
  assert.equal(a.enviados.length, 2);

  a.meta.ultimo_erp_em = String(t0 + 31 * MIN);
  await verificar(a.env, t0 + 32 * MIN);
  assert.equal(a.enviados.length, 3);
  assert.equal(a.enviados[2].title, "SkyHub voltou");
  await verificar(a.env, t0 + 37 * MIN); // em dia de novo: silêncio
  assert.equal(a.enviados.length, 3);
});

test("ntfy recusou: tenta de novo na próxima verificação", async () => {
  const t0 = Date.now();
  const a = ambiente({ ultimo_erp_em: String(t0 - 20 * MIN) });
  globalThis.fetch = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
  assert.match(await verificar(a.env, t0), /HTTP 429/);
  assert.equal(JSON.parse(a.meta.vigia_estado).avisadoEm, 0);
  assert.match(a.logs[0], /HTTP 429/);
});
