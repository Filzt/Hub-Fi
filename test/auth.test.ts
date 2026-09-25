// Login do painel: verificação do JWT do Supabase (ES256) e permissão por módulo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idDaFuncao, moduloDaRota, pode, type Quem, verificarJwt } from "../src/auth.ts";

const URL_SB = "https://exemplo.supabase.co";
const env = { SUPABASE_URL: URL_SB } as never;
const b64u = (b: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? b : new Uint8Array(b as ArrayBuffer)).toString("base64url");

const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const outroPar = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", par.publicKey)), kid: "k1", alg: "ES256" };
globalThis.fetch = (async (u: string) => {
  assert.equal(String(u), `${URL_SB}/auth/v1/.well-known/jwks.json`);
  return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
}) as typeof fetch;

async function jwt(claims: Record<string, unknown>, chave = par.privateKey, kid = "k1") {
  const cab = b64u(JSON.stringify({ alg: "ES256", kid, typ: "JWT" }));
  const corpo = b64u(JSON.stringify(claims));
  const ass = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, chave, new TextEncoder().encode(`${cab}.${corpo}`));
  return `${cab}.${corpo}.${b64u(ass)}`;
}
const agora = () => Math.floor(Date.now() / 1000);
const validos = () => ({ sub: "u1", email: "a@b.com", exp: agora() + 600, iss: `${URL_SB}/auth/v1`, aud: "authenticated" });

test("aceita token válido do projeto", async () => {
  const c = await verificarJwt(env, await jwt(validos()));
  assert.equal(c?.sub, "u1");
});

test("recusa assinatura de outra chave, vencido, outro emissor e outro público", async () => {
  assert.equal(await verificarJwt(env, await jwt(validos(), outroPar.privateKey)), null);
  assert.equal(await verificarJwt(env, await jwt({ ...validos(), exp: agora() - 1 })), null);
  assert.equal(await verificarJwt(env, await jwt({ ...validos(), iss: "https://outro.supabase.co/auth/v1" })), null);
  assert.equal(await verificarJwt(env, await jwt({ ...validos(), aud: "anon" })), null);
  assert.equal(await verificarJwt(env, "lixo"), null);
  const t = await jwt(validos());
  const adulterado = t.split(".").map((x, i) => (i === 1 ? b64u(JSON.stringify({ ...validos(), sub: "admin" })) : x)).join(".");
  assert.equal(await verificarJwt(env, adulterado), null);
});

test("permissão: função só vê os módulos dela; admin vê tudo; rota desconhecida é de admin", () => {
  const exp: Quem = { tipo: "usuario", id: "u", email: "e", nome: "n", funcao: "Expedição", admin: false, modulos: ["expedicao"] };
  const adm: Quem = { ...exp, admin: true, modulos: [] };
  assert.equal(pode(exp, moduloDaRota("GET", "/api/etiquetas")), true);
  assert.equal(pode(exp, moduloDaRota("POST", "/api/pedidos/123/gravar")), false);
  assert.equal(pode(exp, moduloDaRota("GET", "/api/admin/usuarios")), false);
  assert.equal(pode(exp, moduloDaRota("GET", "/api/rota-nova")), false);
  assert.equal(pode(adm, moduloDaRota("GET", "/api/admin/usuarios")), true);
  assert.equal(pode(adm, moduloDaRota("GET", "/api/meli/access-token")), false, "token do ML só para scripts");
  assert.equal(pode({ ...adm, tipo: "sistema" }, moduloDaRota("GET", "/api/meli/access-token")), true);
  assert.equal(pode(exp, moduloDaRota("GET", "/api/eu")), true);
});

test("id da função sem acento", () => {
  assert.equal(idDaFuncao("Expedição Manhã"), "expedicao-manha");
});
