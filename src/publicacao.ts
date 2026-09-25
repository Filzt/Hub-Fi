// Publicação de anúncios no ML a partir do SKU do Sankhya.
//
// Regra do Filipe (25/09/2026): entra na fila o SKU ATIVO no Sankhya, com saldo e sem
// anúncio (a regra antiga "só o que está na Base" caiu com a Base fora do ML). Nada vai
// ao ML sem clique humano; o tipo (Clássico/Premium) é escolhido por SKU na conferência.
//
// Payload = o do skyline/projetos/ml-catalogo/publicar.py, que publicou 140 anúncios em
// set/2026: catalog_product_id da ficha RECONDICIONADA + catalog_listing, recondicionado
// com GRADING, desbloqueado, garantia do vendedor 90 dias, me2 com frete grátis, SKU em
// SELLER_SKU; depois desliga o Flex do anúncio. O ML às vezes troca o catalog_product_id
// pelo do grau enviado (24 de 140) — a auditoria não trata isso como erro.

import { type Quem } from "./auth.ts";
import { candidatas, chaveIndice, faltaAtributo, type Ficha, grauMl, type SkuErp } from "./casamento.ts";
import { LOCAIS_ESTOQUE } from "./config.ts";
import { reguasVigentes } from "./estoque.ts";
import { meliEnviar, meliGet } from "./meli.ts";
import { sqlTexto } from "./nota.ts";
import { consultar } from "./sankhya.ts";
import { storeStub } from "./store.ts";
import { precoAlvo } from "./sync.ts";
import { type Env, ErroDefinitivo, ErroTemporario } from "./tipos.ts";

export const TIPOS = { gold_special: "Clássico", gold_pro: "Premium" } as const;
type Tipo = keyof typeof TIPOS;

// value_id conferidos nos anúncios publicados em set/2026 (publicar.py).
const GRADING_ID: Record<string, string> = { Excelente: "40108830", Bom: "40108831" };
const ITEM_CONDITION_RECONDICIONADO = "2230582";
const CARRIER_DESBLOQUEADO = "298335";
const WARRANTY_TYPE_VENDEDOR = "2230280";
// Só celular por enquanto: o publicar.py fixava MLB1055; tablet/relógio têm outra categoria.
const CATEGORIA_POR_DOMINIO: Record<string, string> = { "MLB-CELLPHONES": "MLB1055" };

export interface SkuPub extends SkuErp { disp: number; preco_loja: number | null }

const numero = (v: unknown) => (v == null || v === "" ? null : Number(v));

// ------------------------------------------------------------------ Sankhya

function sqlCandidatos(filtro: string): string {
  return `SELECT P.REFERENCIA, P.DESCRPROD, P.MARCA, P.AD_CORES, P.AD_ARMAZENAMENTO, P.AD_QUALIDADE,
                 NVL(E.DISP, 0) DISP, PR.VLRVENDA
          FROM TGFPRO P
          JOIN (SELECT CODPROD, SUM(ESTOQUE - RESERVADO) DISP FROM TGFEST
                WHERE CODEMP = 1 AND CODLOCAL IN (${LOCAIS_ESTOQUE.join(",")}) GROUP BY CODPROD) E ON E.CODPROD = P.CODPROD
          LEFT JOIN (SELECT CODPROD, VLRVENDA FROM (
                       SELECT X.CODPROD, X.VLRVENDA,
                              ROW_NUMBER() OVER (PARTITION BY X.CODPROD ORDER BY T.DTVIGOR DESC, T.NUTAB DESC) RN
                       FROM TGFEXC X JOIN TGFTAB T ON T.NUTAB = X.NUTAB
                       WHERE T.CODTAB = 0 AND T.DTVIGOR <= SYSDATE) WHERE RN = 1) PR ON PR.CODPROD = P.CODPROD
          WHERE P.ATIVO = 'S' AND P.REFERENCIA IS NOT NULL AND ${filtro}`;
}

function paraSku(l: Record<string, unknown>): SkuPub {
  return {
    sku: String(l.REFERENCIA).trim().toUpperCase(),
    produto: String(l.DESCRPROD ?? ""),
    marca: String(l.MARCA ?? ""),
    cor: String(l.AD_CORES ?? ""),
    capacidade: String(l.AD_ARMAZENAMENTO ?? ""),
    qualidade: String(l.AD_QUALIDADE ?? ""),
    disp: Math.max(0, Math.floor(Number(l.DISP ?? 0))),
    preco_loja: numero(l.VLRVENDA),
  };
}

/** SKUs ativos com saldo (1 consulta). SKU repetido no cadastro fica de fora — não dá para saber qual publicar. */
export async function lerCandidatosErp(env: Env): Promise<{ skus: SkuPub[]; duplicados: string[] }> {
  const linhas = await consultar(env, sqlCandidatos("NVL(E.DISP, 0) >= 1"));
  const porSku = new Map<string, SkuPub[]>();
  for (const l of linhas) { const x = paraSku(l); (porSku.get(x.sku) ?? porSku.set(x.sku, []).get(x.sku)!).push(x); }
  const duplicados = [...porSku].filter(([, v]) => v.length > 1).map(([k]) => k);
  return { skus: [...porSku].filter(([, v]) => v.length === 1).map(([, v]) => v[0]), duplicados };
}

async function lerSkuErp(env: Env, sku: string): Promise<SkuPub | null> {
  if (!/^[A-Z0-9._-]{1,40}$/.test(sku)) throw new ErroDefinitivo("SKU inválido");
  const l = await consultar(env, sqlCandidatos(`UPPER(TRIM(P.REFERENCIA)) = ${sqlTexto(sku)}`));
  if (l.length > 1) throw new ErroDefinitivo(`SKU ${sku} está duplicado no cadastro do Sankhya (${l.length} produtos)`);
  return l.length ? paraSku(l[0]) : null;
}

const assinatura = (x: SkuErp) => [x.produto, x.marca, x.cor, x.capacidade, x.qualidade].join("|");

// ------------------------------------------------------------------ fila e casamento

/** Atualiza a lista de candidatos do Sankhya (1 vez por hora no cron, ou pelo botão). */
export async function atualizarCandidatos(env: Env): Promise<number> {
  const { skus, duplicados } = await lerCandidatosErp(env);
  const store = storeStub(env);
  await store.setMeta("pub_erp", JSON.stringify({ em: Date.now(), skus, duplicados }));
  return skus.length;
}

async function candidatosAtuais(env: Env): Promise<{ em: number; skus: SkuPub[]; duplicados: string[] }> {
  const bruto = await storeStub(env).meta("pub_erp");
  return bruto ? JSON.parse(bruto) : { em: 0, skus: [], duplicados: [] };
}

async function skusComAnuncio(env: Env): Promise<Set<string>> {
  const an = (await storeStub(env).todosAnuncios()) as Array<{ sku: string; status: string }>;
  return new Set(an.filter((a) => a.sku && a.status !== "closed").map((a) => a.sku));
}

/**
 * Casa até `limite` SKUs da fila que ainda não têm casamento válido (SKU novo, SKU que
 * mudou de cor/grau no cadastro, ou pool de fichas que mudou). Custa ~1 ms por SKU.
 */
export async function casarPendentes(env: Env, limite = 40): Promise<number> {
  const store = storeStub(env);
  const [{ skus }, comAnuncio, feitos, versaoTxt] = await Promise.all([
    candidatosAtuais(env), skusComAnuncio(env), store.casamentos(), store.meta("versao_pool"),
  ]);
  const versao = Number(versaoTxt ?? "0");
  const porSku = new Map(feitos.map((c) => [c.sku, c]));
  const pendentes = skus.filter((x) => {
    if (comAnuncio.has(x.sku)) return false;
    const c = porSku.get(x.sku);
    return !c || c.assinatura !== assinatura(x) || c.versao_pool !== versao;
  }).slice(0, limite);
  if (!pendentes.length) return 0;

  const chaves = [...new Set(pendentes.filter((x) => !faltaAtributo(x)).map((x) => chaveIndice(x.capacidade, grauMl(x.qualidade))))];
  const fichas = (await store.fichasDaChave(chaves)) as Ficha[];
  const indice = new Map<string, Ficha[]>();
  for (const f of fichas) { const k = chaveIndice(f.capacidade, f.grau); (indice.get(k) ?? indice.set(k, []).get(k)!).push(f); }

  await store.salvarCasamentos(pendentes.map((x) => {
    const falta = faltaAtributo(x);
    if (falta) return { sku: x.sku, assinatura: assinatura(x), versao_pool: versao, fichas: "[]", motivo: falta };
    const k = chaveIndice(x.capacidade, grauMl(x.qualidade));
    const achadas = candidatas(x, indice.get(k) ?? []).slice(0, 5).map((f) => ({ pdp: f.pdp, nome: f.nome, cor: f.cor, status: f.status }));
    return { sku: x.sku, assinatura: assinatura(x), versao_pool: versao, fichas: JSON.stringify(achadas), motivo: achadas.length ? null : "nenhuma ficha no pool" };
  }));
  return pendentes.length;
}

/** A fila para o painel: candidatos sem anúncio, com a ficha sugerida e o preço pela régua. */
export async function fila(env: Env) {
  const store = storeStub(env);
  const [cand, comAnuncio, feitos, ocupadas, pubs, reguas, versaoTxt, nFichas] = await Promise.all([
    candidatosAtuais(env), skusComAnuncio(env), store.casamentos(), store.fichasOcupadas(), store.listarPublicacoes(500),
    reguasVigentes(env), store.meta("versao_pool"), store.contagemFichas(),
  ]);
  const versao = Number(versaoTxt ?? "0");
  const porSku = new Map(feitos.map((c) => [c.sku, c]));
  const ocup = new Map(ocupadas.map((o) => [`${o.catalog_product_id}|${o.listing_type}`, o]));
  const ultimaPub = new Map<string, Record<string, unknown>>();
  for (const p of pubs as Array<Record<string, unknown>>) if (!ultimaPub.has(String(p.sku))) ultimaPub.set(String(p.sku), p);
  const itens = cand.skus.filter((x) => !comAnuncio.has(x.sku)).map((x) => {
    const c = porSku.get(x.sku);
    const atual = c && c.assinatura === assinatura(x) && c.versao_pool === versao;
    const fichas = atual ? (JSON.parse(c!.fichas) as Array<{ pdp: string; nome: string; cor: string; status: string }>) : [];
    return {
      ...x,
      grau_ml: grauMl(x.qualidade),
      casado: !!atual,
      motivo: atual ? c!.motivo : "casamento pendente (roda a cada 2 min)",
      fichas: fichas.map((f) => ({ ...f, ocupada_classico: ocup.has(`${f.pdp}|gold_special`), ocupada_premium: ocup.has(`${f.pdp}|gold_pro`) })),
      precos: Object.fromEntries(Object.keys(TIPOS).map((t) => [t, precoAlvo(x.preco_loja, t, reguas)])),
      ultima_publicacao: ultimaPub.get(x.sku) ?? null,
    };
  });
  return { atualizadoEm: cand.em, duplicados: cand.duplicados, totalFichas: nFichas, itens, publicacoes: pubs.slice(0, 50) };
}

// ------------------------------------------------------------------ conferência (ao vivo no ML)

type ProdutoMl = {
  id: string; name?: string; status?: string; domain_id?: string; parent_id?: string | null; catalog_product_id?: string | null;
  pdp_types?: string[]; children_ids?: string[]; pictures?: Array<{ url?: string; secure_url?: string }>;
  attributes?: Array<{ id: string; value_name?: string | null }>;
};
const attr = (p: ProdutoMl, ...ids: string[]) => (p.attributes ?? []).find((a) => ids.includes(a.id))?.value_name ?? "";

async function produto(env: Env, pdp: string): Promise<ProdutoMl | null> {
  try { return await meliGet<ProdutoMl>(env, `/products/${pdp}`); } catch (e) { if (/HTTP 404/.test((e as Error).message)) return null; throw e; }
}

/** Anúncios que competem na ficha (404 = ficha sem anúncio, entrada sem concorrência). */
async function concorrentes(env: Env, pdp: string): Promise<{ total: number; menor: number | null; nossos: number }> {
  try {
    const d = await meliGet<{ results?: Array<{ price?: number; seller_id?: number }> }>(env, `/products/${pdp}/items`);
    const r = d.results ?? [];
    const precos = r.map((x) => Number(x.price)).filter((v) => v > 0);
    return { total: r.length, menor: precos.length ? Math.min(...precos) : null, nossos: r.filter((x) => String(x.seller_id) === env.MELI_USER_ID).length };
  } catch (e) {
    if (/HTTP 404/.test((e as Error).message)) return { total: 0, menor: null, nossos: 0 };
    throw e;
  }
}

export async function conferir(env: Env, sku: string) {
  const store = storeStub(env);
  const x = await lerSkuErp(env, sku);
  if (!x) throw new ErroDefinitivo(`SKU ${sku} não está ativo com saldo no Sankhya`);
  const c = (await store.casamentos()).find((k) => k.sku === sku);
  const pdps = c ? (JSON.parse(c.fichas) as Array<{ pdp: string }>).map((f) => f.pdp) : [];
  const reguas = await reguasVigentes(env);
  const ocup = await store.fichasOcupadas();
  const fichas = [];
  for (const pdp of pdps) {
    const [p, conc] = await Promise.all([produto(env, pdp), concorrentes(env, pdp)]);
    fichas.push({
      pdp,
      link: `https://www.mercadolivre.com.br/p/${pdp}`,
      nome: p?.name ?? "(ficha não encontrada no ML)",
      status: p?.status ?? "inexistente",
      imagem: p?.pictures?.[0]?.secure_url ?? p?.pictures?.[0]?.url ?? null,
      grau: p ? attr(p, "GRADING") : "", cor: p ? attr(p, "COLOR") : "", capacidade: p ? attr(p, "INTERNAL_MEMORY", "CAPACITY") : "",
      categoria: p?.domain_id ? CATEGORIA_POR_DOMINIO[p.domain_id] ?? null : null,
      dominio: p?.domain_id ?? null,
      concorrentes: conc,
      ocupada: ocup.filter((o) => o.catalog_product_id === pdp).map((o) => ({ tipo: o.listing_type, mlb: o.item_id, sku: o.sku })),
    });
  }
  return {
    sku: x, grau_ml: grauMl(x.qualidade), motivo: c?.motivo ?? null, fichas,
    precos: Object.fromEntries(Object.keys(TIPOS).map((t) => [t, precoAlvo(x.preco_loja, t, reguas)])),
  };
}

// ------------------------------------------------------------------ publicar

export async function publicar(env: Env, quem: Quem, pedido: { sku?: unknown; pdp?: unknown; tipo?: unknown }) {
  const sku = String(pedido.sku ?? "").trim().toUpperCase();
  const pdp = String(pedido.pdp ?? "").trim().toUpperCase();
  const tipo = String(pedido.tipo ?? "") as Tipo;
  if (!/^MLB\d{5,15}$/.test(pdp)) throw new ErroDefinitivo("ficha inválida");
  if (!(tipo in TIPOS)) throw new ErroDefinitivo("tipo de anúncio inválido");
  const store = storeStub(env);
  const trava = `publicar:${sku}`;
  if (!(await store.travar(trava, 3 * 60_000))) throw new ErroTemporario(`publicação do ${sku} já em andamento`);
  try {
    // 1. Tudo de novo, ao vivo: nada vem do navegador além de SKU, ficha e tipo.
    const x = await lerSkuErp(env, sku);
    if (!x) throw new ErroDefinitivo(`${sku} não está ativo com saldo no Sankhya`);
    if (x.disp < 1) throw new ErroDefinitivo(`${sku} sem saldo`);
    const falta = faltaAtributo(x);
    if (falta) throw new ErroDefinitivo(`${sku}: ${falta}`);
    const grau = grauMl(x.qualidade) ?? "";
    if (!GRADING_ID[grau]) throw new ErroDefinitivo(`grau ${grau} não é publicado pelo SkyHub (o publicar.py também só publicava Excelente e Bom)`);

    // 2. A ficha escolhida tem que passar no mesmo casamento de sempre.
    const ficha = ((await store.fichasPorPdp([pdp])) as unknown as Ficha[])[0];
    if (!ficha) throw new ErroDefinitivo("ficha fora do pool do SkyHub");
    if (!candidatas(x, [ficha]).length) throw new ErroDefinitivo("a ficha escolhida não casa com o SKU (modelo, cor, capacidade ou grau)");
    const p = await produto(env, pdp);
    if (!p) throw new ErroDefinitivo("ficha não existe mais no ML");
    if (p.status !== "active") throw new ErroDefinitivo(`ficha ${p.status ?? "sem status"} no ML`);
    const categoria = p.domain_id ? CATEGORIA_POR_DOMINIO[p.domain_id] : undefined;
    if (!categoria) throw new ErroDefinitivo(`categoria ${p.domain_id ?? "desconhecida"} ainda não é publicada pelo SkyHub (só celular)`);
    if (attr(p, "GRADING") && attr(p, "GRADING") !== grau) throw new ErroDefinitivo(`a ficha é ${attr(p, "GRADING")} e o SKU é ${grau}`);

    // 3. Duplicata: SKU já anunciado (ao vivo no ML) ou ficha+tipo já ocupados por nós.
    const busca = await meliGet<{ results?: string[] }>(env, `/users/${env.MELI_USER_ID}/items/search?seller_sku=${encodeURIComponent(sku)}`);
    if (busca.results?.length) {
      const st = await meliGet<Array<{ code: number; body?: { id: string; status?: string } }>>(env, `/items?ids=${busca.results.slice(0, 20).join(",")}&attributes=id,status`);
      const vivos = st.filter((r) => r.code === 200 && r.body?.status !== "closed").map((r) => `${r.body!.id} (${r.body!.status})`);
      if (vivos.length) throw new ErroDefinitivo(`${sku} já tem anúncio: ${vivos.join(", ")} — abasteça/reative em vez de publicar de novo`);
    }
    const ocupada = (await store.fichasOcupadas()).find((o) => o.catalog_product_id === pdp && o.listing_type === tipo);
    if (ocupada) throw new ErroDefinitivo(`a ficha já tem anúncio ${TIPOS[tipo]} nosso (${ocupada.item_id}, SKU ${ocupada.sku}) — o ML derruba o mais novo`);

    // 4. Conta liberada para publicar (a 3ª advertência suspendeu em 20/09/2026).
    const eu = await meliGet<{ status?: { list?: { allow?: boolean } } }>(env, "/users/me");
    if (eu.status?.list?.allow === false) throw new ErroDefinitivo("a conta do ML está impedida de publicar agora (status.list.allow = false)");

    // 5. Preço pela régua da Precificação (a mesma da sincronização).
    const preco = precoAlvo(x.preco_loja, tipo, await reguasVigentes(env));
    if (preco == null) throw new ErroDefinitivo(`${sku} sem preço de loja (tabela 0) no Sankhya`);

    const corpo = {
      site_id: "MLB", category_id: categoria, price: preco, currency_id: "BRL",
      available_quantity: x.disp, buying_mode: "buy_it_now", listing_type_id: tipo,
      catalog_product_id: pdp, catalog_listing: true,
      attributes: [
        { id: "ITEM_CONDITION", value_id: ITEM_CONDITION_RECONDICIONADO },
        { id: "GRADING", value_id: GRADING_ID[grau] },
        { id: "CARRIER", value_id: CARRIER_DESBLOQUEADO },
        { id: "SELLER_SKU", value_name: sku },
      ],
      // Só value_struct dá 400 "Refurbished Items need to have Warranty Time" (publicar.py).
      sale_terms: [
        { id: "WARRANTY_TYPE", value_id: WARRANTY_TYPE_VENDEDOR },
        { id: "WARRANTY_TIME", value_name: "90 dias", value_struct: { number: 90, unit: "dias" } },
      ],
      shipping: { mode: "me2", free_shipping: true, local_pick_up: false },
    };
    const r = await meliEnviar(env, "POST", "/items", JSON.stringify(corpo), "application/json");
    if (r.status !== 201 && r.status !== 200) {
      const causas = Array.isArray(r.corpo?.cause) ? r.corpo.cause.map((c: { message?: string }) => c.message).filter(Boolean).join(" | ") : "";
      const detalhe = `HTTP ${r.status}: ${r.corpo?.message ?? ""}${causas ? " — " + causas : ""}`.slice(0, 600);
      await store.registrarPublicacao({ sku, pdp, tipo, preco, qtd: x.disp, status: "erro", mlb: null, detalhe, quem: quem.email });
      await store.log("aviso", null, `publicação recusada pelo ML: ${sku} → ${pdp} (${TIPOS[tipo]}) — ${detalhe}`);
      throw new ErroDefinitivo(`o ML recusou: ${detalhe}`);
    }
    const mlb = String(r.corpo?.id ?? "");
    // Flex nasce ligado (assinatura da conta); o publicar.py desligava anúncio a anúncio.
    let flex = "desligado";
    try {
      const f = await meliEnviar(env, "DELETE", `/flex/sites/MLB/items/${mlb}/v2`, null);
      if (f.status !== 204 && f.status !== 200) flex = `não desligou (HTTP ${f.status})`;
    } catch (e) { flex = `não desligou (${(e as Error).message.slice(0, 80)})`; }

    await store.salvarAnuncios([{
      item_id: mlb, sku, status: String(r.corpo?.status ?? "active"), sub_status: (r.corpo?.sub_status ?? []).join(","),
      qtd_ml: x.disp, preco_ml: preco, listing_type: tipo, catalog_product_id: String(r.corpo?.catalog_product_id ?? pdp),
    }]);
    const id = await store.registrarPublicacao({ sku, pdp, tipo, preco, qtd: x.disp, status: "criado", mlb, detalhe: `Flex ${flex}`, quem: quem.email });
    await store.log("info", null, `anúncio publicado: ${mlb} — ${sku} na ficha ${pdp} (${TIPOS[tipo]}), R$ ${preco}, ${x.disp} un., por ${quem.email}; Flex ${flex}`);
    return { id, mlb, preco, qtd: x.disp, tipo: TIPOS[tipo], link: r.corpo?.permalink ?? `https://produto.mercadolivre.com.br/${mlb.replace(/^MLB/, "MLB-")}`, flex };
  } finally {
    await store.destravar(trava);
  }
}

// ------------------------------------------------------------------ auditoria (cron)

/** Relê no ML os anúncios criados há 5+ min e confere o essencial. */
export async function auditarPublicacoes(env: Env): Promise<number> {
  const store = storeStub(env);
  const lista = (await store.publicacoesParaAuditar(Date.now() - 5 * 60_000)).slice(0, 5); // poupa subrequests do cron
  for (const p of lista) {
    let it: { status?: string; listing_type_id?: string; price?: number; catalog_listing?: boolean; attributes?: Array<{ id: string; value_name?: string | null }> };
    try { it = await meliGet(env, `/items/${p.mlb}`); } catch (e) { await store.marcarAuditoria(p.id, "divergente", `não consegui ler: ${(e as Error).message.slice(0, 200)}`); continue; }
    const a = (id: string) => (it.attributes ?? []).find((x) => x.id === id)?.value_name ?? "";
    const problemas: string[] = [];
    if (!["active", "paused"].includes(String(it.status))) problemas.push(`status ${it.status}`);
    if (a("SELLER_SKU").toUpperCase() !== p.sku) problemas.push(`SKU no ML = ${a("SELLER_SKU") || "vazio"}`);
    if (it.listing_type_id !== p.tipo) problemas.push(`tipo ${it.listing_type_id}`);
    if (p.preco != null && Math.abs(Number(it.price) - p.preco) > 0.01) problemas.push(`preço ${it.price}`);
    if (it.catalog_listing === false) problemas.push("fora do catálogo");
    await store.marcarAuditoria(p.id, problemas.length ? "divergente" : "auditado", problemas.length ? problemas.join("; ") : "conferido no ML");
    if (problemas.length) await store.log("aviso", null, `anúncio ${p.mlb} (${p.sku}) divergente: ${problemas.join("; ")}`);
  }
  return lista.length;
}

// ------------------------------------------------------------------ pool de fichas

function linhaFicha(d: ProdutoMl) {
  const grau = attr(d, "GRADING"), capacidade = attr(d, "INTERNAL_MEMORY", "CAPACITY");
  return {
    pdp: d.id, nome: d.name ?? "", grau, cor: attr(d, "COLOR"), capacidade, marca: attr(d, "BRAND"), modelo: attr(d, "MODEL"),
    status: d.status ?? "", parent_id: d.parent_id ?? null, pdp_tradicional: d.catalog_product_id ?? null, chave: chaveIndice(capacidade, grau),
  };
}

/** Importação em lote (pool já levantado pelo ml-catalogo): linhas do 11_pool_fichas.csv. */
export async function importarFichas(env: Env, linhas: Array<Record<string, unknown>>): Promise<number> {
  const ok = linhas.filter((l) => /^MLB\d{5,15}$/.test(String(l.pdp ?? "")) && String(l.nome ?? "").trim()).slice(0, 1000).map((l) => ({
    pdp: String(l.pdp), nome: String(l.nome), grau: String(l.grau ?? ""), cor: String(l.cor ?? ""), capacidade: String(l.capacidade ?? ""),
    marca: String(l.marca ?? ""), modelo: String(l.modelo ?? ""), status: String(l.status ?? ""),
    parent_id: l.parent_id ? String(l.parent_id) : null, pdp_tradicional: l.pdp_tradicional ? String(l.pdp_tradicional) : null,
    chave: chaveIndice(l.capacidade, l.grau),
  }));
  return storeStub(env).salvarFichas(ok);
}

/**
 * Família inteira a partir do link de UMA ficha recondicionada (substitui o script do
 * Chrome). Só navega recondicionado → pai → filhos: o PDP tradicional não aponta para
 * o recondicionado. Até 35 filhos na hora; o resto fica na fila do cron.
 */
export async function adicionarFamilia(env: Env, link: string): Promise<{ lidas: number; na_fila: number; pai: string | null }> {
  const id = (String(link).toUpperCase().match(/MLB-?(\d{5,15})/) ?? [])[1];
  if (!id) throw new ErroDefinitivo("cole o link da ficha (…mercadolivre.com.br/p/MLB…)");
  const semente = await produto(env, `MLB${id}`);
  if (!semente) throw new ErroDefinitivo("ficha não encontrada no ML");
  if (!(semente.pdp_types ?? []).includes("refurbished")) {
    throw new ErroDefinitivo("essa ficha não é de recondicionado — abra no ML a versão recondicionada (o título termina em “(Recondicionado)”) e cole esse link");
  }
  const store = storeStub(env);
  const novas = [linhaFicha(semente)];
  let filhos: string[] = [];
  if (semente.parent_id) {
    const pai = await produto(env, semente.parent_id);
    filhos = (pai?.children_ids ?? []).filter((f) => f !== semente.id);
  }
  const agora = filhos.slice(0, 35), depois = filhos.slice(35);
  for (const f of agora) { const d = await produto(env, f); if (d) novas.push(linhaFicha(d)); }
  await store.salvarFichas(novas);
  if (depois.length) {
    const fila0 = JSON.parse((await store.meta("fichas_fila")) ?? "[]") as string[];
    await store.setMeta("fichas_fila", JSON.stringify([...new Set([...fila0, ...depois])]));
  }
  await store.log("info", null, `família de fichas adicionada a partir de MLB${id}: ${novas.length} lidas, ${depois.length} na fila`);
  return { lidas: novas.length, na_fila: depois.length, pai: semente.parent_id ?? null };
}

/** Cron: lê fichas que ficaram na fila da expansão de família. */
export async function processarFilaFichas(env: Env, limite = 15): Promise<number> {
  const store = storeStub(env);
  const fila0 = JSON.parse((await store.meta("fichas_fila")) ?? "[]") as string[];
  if (!fila0.length) return 0;
  const agora = fila0.slice(0, limite);
  const novas = [];
  for (const f of agora) { const d = await produto(env, f); if (d) novas.push(linhaFicha(d)); }
  await store.salvarFichas(novas);
  await store.setMeta("fichas_fila", JSON.stringify(fila0.slice(limite)));
  return agora.length;
}
