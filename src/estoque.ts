// Sincronização de estoque e preço Sankhya → Mercado Livre (planejamento em sync.ts).
//
// Orçamento por rodada (o Worker tem teto de subrequests por invocação):
//   - catálogo: descoberta de anúncios 1x/hora (search scan) + releitura de 40
//     anúncios por rodada, os mais antigos primeiro (cron 2 min → ciclo ~23 min);
//   - ERP: 1 consulta com saldo, ativo e preço de todos os SKUs anunciados;
//   - antes de escrever, relê do ML só os anúncios que vão mudar (dado fresco);
//   - no máximo MAX_PUTS alterações por rodada; o resto fica para a próxima.
// Modos: ESTOQUE_MODO / PRECO_MODO = sombra (só planeja) | automatico (aplica).

import { meliEnviar, meliGet } from "./meli.ts";
import { sqlTexto } from "./nota.ts";
import { consultar } from "./sankhya.ts";
import { storeStub } from "./store.ts";
import { type AnuncioSync, type ErpSku, motivoParaAbortar, planejar, REGUA_PRECO, type Reguas } from "./sync.ts";
import type { Env } from "./tipos.ts";

const LOTE_RELEITURA = 40; // com cron a cada 2 min: ciclo completo ~23 min e ~29 mil gravações/dia no DO
const MAX_PUTS = 15;
const MAX_ZERAR = 30;
const CATALOGO_A_CADA_MS = 60 * 60_000;

type ItemMl = {
  id: string;
  status?: string;
  sub_status?: string[];
  available_quantity?: number;
  price?: number;
  listing_type_id?: string;
  attributes?: Array<{ id: string; value_name?: string | null }>;
};

function paraAnuncio(b: ItemMl): AnuncioSync {
  const sku = (b.attributes ?? []).find((a) => a.id === "SELLER_SKU")?.value_name ?? "";
  return {
    item_id: b.id,
    sku: String(sku).trim().toUpperCase(),
    status: b.status ?? "",
    sub_status: (b.sub_status ?? []).join(","),
    qtd_ml: Number(b.available_quantity ?? 0),
    preco_ml: b.price == null ? null : Number(b.price),
    listing_type: b.listing_type_id ?? "",
  };
}

/** Multiget de até 20 anúncios por chamada (limite da API). */
async function lerItens(env: Env, ids: string[]): Promise<AnuncioSync[]> {
  const out: AnuncioSync[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20).join(",");
    const r = await meliGet<Array<{ code: number; body: ItemMl }>>(
      env, `/items?ids=${lote}&attributes=id,status,sub_status,available_quantity,price,listing_type_id,attributes`,
    );
    for (const x of r) if (x.code === 200 && x.body?.id) out.push(paraAnuncio(x.body));
  }
  return out;
}

/** Todos os ids active/paused da conta (search scan, 100 por página). */
async function descobrirIds(env: Env): Promise<string[]> {
  const ids: string[] = [];
  for (const status of ["active", "paused"]) {
    let scroll = "";
    for (let pag = 0; pag < 20; pag++) {
      const q = `/users/${env.MELI_USER_ID}/items/search?search_type=scan&limit=100&status=${status}${scroll ? `&scroll_id=${encodeURIComponent(scroll)}` : ""}`;
      const d = await meliGet<{ results?: string[]; scroll_id?: string }>(env, q);
      if (!d.results?.length) break;
      ids.push(...d.results);
      scroll = d.scroll_id ?? "";
      if (!scroll) break;
    }
  }
  return [...new Set(ids)];
}

/** Saldo disponível, situação e preço de loja (tabela 0) por SKU, direto do Sankhya. */
/** Régua vigente: a salva pelo time na Precificação, senão a padrão. */
export async function reguasVigentes(env: Env): Promise<Reguas> {
  const salvo = await storeStub(env).meta("reguas");
  if (!salvo) return REGUA_PRECO;
  try {
    return { ...REGUA_PRECO, ...(JSON.parse(salvo) as { reguas: Reguas }).reguas };
  } catch {
    return REGUA_PRECO;
  }
}

/** Snapshot do ERP gravado na última rodada (para Produtos e simulação de régua). */
export async function erpDaUltimaRodada(env: Env): Promise<Map<string, ErpSku>> {
  const bruto = await storeStub(env).meta("ultimo_erp");
  const mapa = new Map<string, ErpSku>();
  if (!bruto) return mapa;
  for (const [sku, [disp, ativo, preco]] of Object.entries(JSON.parse(bruto) as Record<string, [number, number, number | null]>)) {
    mapa.set(sku, { disp, ativo: ativo === 1, preco_loja: preco });
  }
  return mapa;
}

export async function lerErp(env: Env, skus: string[]): Promise<{ mapa: Map<string, ErpSku>; duplicados: string[] }> {
  const mapa = new Map<string, ErpSku>();
  const vistos = new Map<string, number>();
  const validos = skus.filter((s) => /^[A-Z0-9._-]{1,40}$/.test(s));
  for (let i = 0; i < validos.length; i += 900) {
    const lista = validos.slice(i, i + 900).map(sqlTexto).join(",");
    const linhas = await consultar(
      env,
      `SELECT P.REFERENCIA, P.ATIVO, NVL(E.DISP, 0) DISP, PR.VLRVENDA
       FROM TGFPRO P
       LEFT JOIN (SELECT CODPROD, SUM(ESTOQUE - RESERVADO) DISP FROM TGFEST
                  WHERE CODEMP = 1 AND CODLOCAL = 0 GROUP BY CODPROD) E ON E.CODPROD = P.CODPROD
       LEFT JOIN (SELECT CODPROD, VLRVENDA FROM (
                    SELECT X.CODPROD, X.VLRVENDA,
                           ROW_NUMBER() OVER (PARTITION BY X.CODPROD ORDER BY T.DTVIGOR DESC, T.NUTAB DESC) RN
                    FROM TGFEXC X JOIN TGFTAB T ON T.NUTAB = X.NUTAB
                    WHERE T.CODTAB = 0 AND T.DTVIGOR <= SYSDATE) WHERE RN = 1) PR ON PR.CODPROD = P.CODPROD
       WHERE P.REFERENCIA IN (${lista})`,
    );
    for (const l of linhas) {
      const ref = String(l.REFERENCIA).trim().toUpperCase();
      vistos.set(ref, (vistos.get(ref) ?? 0) + 1);
      mapa.set(ref, {
        disp: Number(l.DISP ?? 0),
        ativo: l.ATIVO === "S",
        preco_loja: l.VLRVENDA == null ? null : Number(l.VLRVENDA),
      });
    }
  }
  // REFERENCIA repetida no ERP (ex.: CEL1057): não dá para saber qual cadastro vale — fica de fora.
  const duplicados = [...vistos].filter(([, n]) => n > 1).map(([r]) => r);
  for (const r of duplicados) mapa.delete(r);
  return { mapa, duplicados };
}

export async function sincronizarEstoque(env: Env, opts: { forcarCatalogo?: boolean } = {}) {
  const store = storeStub(env);
  const aplicarQtd = env.ESTOQUE_MODO === "automatico";
  const aplicarPreco = env.PRECO_MODO === "automatico";

  // 1. Catálogo: descoberta 1x/hora + releitura em fatias -------------------------
  const ultimaDescoberta = Number((await store.meta("catalogo_em")) ?? 0);
  if (opts.forcarCatalogo || Date.now() - ultimaDescoberta > CATALOGO_A_CADA_MS) {
    const ids = await descobrirIds(env);
    if (ids.length) {
      await store.registrarIdsAnuncios(ids);
      await store.setMeta("catalogo_em", String(Date.now()));
    }
  }
  const aReler = await store.idsParaReler(LOTE_RELEITURA);
  if (aReler.length) await store.salvarAnuncios(await lerItens(env, aReler));
  const anuncios = (await store.anunciosAtivos()) as unknown as AnuncioSync[];

  // 2. ERP e plano ---------------------------------------------------------------
  const skus = [...new Set(anuncios.map((a) => a.sku).filter(Boolean))];
  const { mapa, duplicados } = await lerErp(env, skus);
  // 1 gravação por rodada (em vez de 1 por SKU) — alimenta Produtos e a simulação de régua.
  await store.setMeta("ultimo_erp", JSON.stringify(Object.fromEntries([...mapa].map(([k, v]) => [k, [v.disp, v.ativo ? 1 : 0, v.preco_loja]]))));
  await store.setMeta("ultimo_erp_em", String(Date.now()));
  const reguas = await reguasVigentes(env);
  const plano = planejar(anuncios, mapa, reguas);
  for (const d of duplicados) plano.alertas.push(`SKU ${d} tem mais de um cadastro no Sankhya — não mexo`);
  const comSaldo = [...mapa.values()].filter((x) => x.ativo && x.disp > 0).length;
  const anterior = Number((await store.meta("com_saldo")) ?? 0) || null;
  const abortar = motivoParaAbortar(plano.acoes, {
    skusPedidos: skus.length, skusLidos: mapa.size + duplicados.length, comSaldo, comSaldoAnterior: anterior, maxZerar: MAX_ZERAR,
  });

  const resumo = {
    em: Date.now(), modos: { estoque: env.ESTOQUE_MODO, preco: env.PRECO_MODO }, anuncios: anuncios.length,
    skus: skus.length, comSaldo, acoes: plano.acoes.length, ignorados: plano.ignorados, abortado: abortar,
    aplicadas: 0, falhas: 0,
  };
  if (abortar) {
    await store.log("erro", null, `estoque/preço: rodada ABORTADA — ${abortar}`);
    await store.setMeta("ultimo_plano", JSON.stringify({ resumo, acoes: plano.acoes, alertas: plano.alertas }));
    return resumo;
  }
  await store.setMeta("com_saldo", String(comSaldo));

  // 3. Aplicar (só o que o modo permite), relendo do ML o que vai mudar -----------
  const aplicaveis = plano.acoes.filter((a) => (aplicarQtd && a.qtd_para != null) || (aplicarPreco && a.preco_para != null));
  const resultados: Record<string, string> = {};
  if (aplicaveis.length) {
    const lote = aplicaveis.slice(0, MAX_PUTS);
    const frescos = await lerItens(env, lote.map((a) => a.item_id));
    await store.salvarAnuncios(frescos);
    const replano = planejar(frescos, mapa, reguas); // com dado do ML de agora
    for (const a of replano.acoes) {
      const corpo: Record<string, number> = {};
      if (aplicarQtd && a.qtd_para != null) corpo.available_quantity = a.qtd_para;
      if (aplicarPreco && a.preco_para != null) corpo.price = a.preco_para;
      if (!Object.keys(corpo).length) continue;
      const r = await meliEnviar(env, "PUT", `/items/${a.item_id}`, JSON.stringify(corpo), "application/json");
      const ok = r.status === 200;
      const txt = `${ok ? "ok" : `HTTP ${r.status}`} ${JSON.stringify(corpo)}${ok ? "" : " " + JSON.stringify(r.corpo).slice(0, 200)}`;
      resultados[a.item_id] = txt;
      await store.registrarAcaoAnuncio(a.item_id, txt, ok ? corpo.available_quantity ?? null : null, ok ? corpo.price ?? null : null);
      if (ok) resumo.aplicadas++; else resumo.falhas++;
    }
    await store.log(resumo.falhas ? "aviso" : "info", null,
      `estoque/preço: ${resumo.aplicadas} anúncios atualizados, ${resumo.falhas} falhas (de ${plano.acoes.length} no plano)`);
  }
  await store.setMeta("ultimo_plano", JSON.stringify({
    resumo, alertas: plano.alertas,
    acoes: plano.acoes.map((a) => ({ ...a, resultado: resultados[a.item_id] ?? null })),
  }));
  return resumo;
}
