// Envio Flex do Mercado Livre: estado da assinatura e ativar/desativar por anúncio.
//
// Doc oficial (developers.mercadolivre.com.br/pt_br/envios-flex, lida em 25/09/2026, atualizada 22/09/2026):
//   GET/POST/DELETE /flex/sites/MLB/items/{id}/v2  → {"has_flex"} / 204 / 204
//   POST 400 "item is already in flex", 403 "item down" (item não oferece Flex), 409 conflito
//   GET /flex/sites/MLB/users/{user}/subscriptions/v1, .../configurations/coverage/zones/v1 e /delivery-ranges/v1
//   Limite de 1000 rpm nos recursos Flex.
// A doc pede que a ativação seja decisão deliberada do vendedor, não processo automático:
// por isso aqui só existe a ação por clique no painel (com quem clicou no log), nunca no cron.
// Zonas, horário de corte e capacidade ficam no painel do ML; o SkyHub só mostra.

import { ErroDefinitivo, type Env } from "./tipos.ts";
import { meliEnviar, meliGet } from "./meli.ts";
import { storeStub } from "./store.ts";

export const MAX_FLEX_POR_CHAMADA = 50;

type Faixa = { capacity?: number; from?: number; to?: number; cutoff?: number };

export interface ConfigFlex {
  assinatura: string | null; // "in" = ativa
  origem: string | null;
  zonas: string[];
  janela: string | null; // same_day | next_day
  faixas: Record<string, Faixa[]>; // week / saturday / sunday
  erro?: string;
}

/** Assinatura e configuração Flex da conta, ao vivo (3 GETs). */
export async function configFlex(env: Env): Promise<ConfigFlex> {
  const base = `/flex/sites/MLB/users/${env.MELI_USER_ID}`;
  const vazio: ConfigFlex = { assinatura: null, origem: null, zonas: [], janela: null, faixas: {} };
  try {
    const subs = await meliGet<Array<{ mode?: string; status?: string; service_id?: number; origin?: { address_line?: string; zip_code?: string } }>>(env, `${base}/subscriptions/v1`);
    const s = (Array.isArray(subs) ? subs : []).find((x) => x.mode === "FLEX");
    if (!s) return { ...vazio, erro: "a conta não tem assinatura Flex" };
    const cfg = `${base}/services/${s.service_id}/configurations`;
    const [zonas, faixas] = await Promise.all([
      meliGet<{ zones?: Array<{ id: string }> }>(env, `${cfg}/coverage/zones/v1`).catch(() => ({ zones: [] })),
      meliGet<{ delivery_window?: string; delivery_ranges?: Record<string, Faixa[]> }>(env, `${cfg}/delivery-ranges/v1`).catch(() => ({})),
    ]);
    return {
      assinatura: s.status ?? null,
      origem: s.origin ? [s.origin.address_line, s.origin.zip_code].filter(Boolean).join(" · ") : null,
      zonas: (zonas.zones ?? []).map((z) => z.id),
      janela: (faixas as { delivery_window?: string }).delivery_window ?? null,
      faixas: (faixas as { delivery_ranges?: Record<string, Faixa[]> }).delivery_ranges ?? {},
    };
  } catch (e) {
    return { ...vazio, erro: (e as Error).message.slice(0, 200) };
  }
}

export interface ResultadoFlex { item_id: string; ok: boolean; flex: 0 | 1 | null; detalhe: string }

/**
 * Liga ou desliga o Flex nos anúncios pedidos, um por vez, e confere cada um lendo de volta.
 * Idempotente: pedir para ligar o que já está ligado conta como ok.
 */
export async function alterarFlex(env: Env, ids: unknown, ativar: boolean, quem: string): Promise<ResultadoFlex[]> {
  const lista = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x).trim().toUpperCase()))].filter((x) => /^MLB\d{6,15}$/.test(x));
  if (!lista.length) throw new ErroDefinitivo("nenhum anúncio válido");
  if (lista.length > MAX_FLEX_POR_CHAMADA) throw new ErroDefinitivo(`máximo de ${MAX_FLEX_POR_CHAMADA} anúncios por vez`);
  const store = storeStub(env);
  const out: ResultadoFlex[] = [];
  for (const id of lista) {
    const caminho = `/flex/sites/MLB/items/${id}/v2`;
    let detalhe = "";
    try {
      const r = await meliEnviar(env, ativar ? "POST" : "DELETE", caminho, null);
      const msg = String(r.corpo?.message ?? r.corpo?.error ?? "").slice(0, 120);
      if (r.status === 403) detalhe = "o anúncio não aceita Flex (item down)";
      else if (r.status === 409) detalhe = "o ML estava mexendo neste anúncio; tente de novo";
      else if (r.status >= 400 && !(ativar && r.status === 400 && /already/i.test(msg))) detalhe = `HTTP ${r.status} ${msg}`.trim();
    } catch (e) {
      detalhe = (e as Error).message.slice(0, 160);
    }
    // Confere lendo de volta: só conta como feito o que o ML confirma.
    let flex: 0 | 1 | null = null;
    try {
      const g = await meliGet<{ has_flex?: boolean }>(env, caminho);
      flex = g.has_flex === true ? 1 : g.has_flex === false ? 0 : null;
    } catch { /* fica null */ }
    if (flex !== null) await store.marcarFlex(id, flex);
    const ok = flex === (ativar ? 1 : 0);
    out.push({ item_id: id, ok, flex, detalhe: ok ? "" : detalhe || "o ML não confirmou a mudança" });
  }
  const feitos = out.filter((r) => r.ok).length;
  await store.log(feitos === out.length ? "info" : "aviso", null,
    `Flex ${ativar ? "ativado" : "desativado"} por ${quem}: ${feitos} de ${out.length}` +
    (feitos < out.length ? ` — falharam: ${out.filter((r) => !r.ok).map((r) => `${r.item_id} (${r.detalhe})`).join(", ").slice(0, 600)}` : ""));
  return out;
}
