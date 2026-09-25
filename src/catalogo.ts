// Produtos por SKU, com a situação em cada canal de venda.
//
// A linha é o SKU do Sankhya (fonte do cadastro, saldo e preço de loja); cada canal diz se
// o SKU está nele e como. Hoje só o Mercado Livre é integrado — a Nuvemshop entra aqui
// como mais uma chave em `canais`, sem mudar a tela.
//
// De onde vem cada SKU:
//   - SKUs com anúncio no ML: snapshot do ERP da última rodada de estoque (ultimo_erp);
//   - SKUs ativos com saldo sem anúncio: lista da publicação (pub_erp), relida de hora em hora.

import { type AnuncioSync, type ErpSku, precoAlvo, type Reguas } from "./sync.ts";

export type SituacaoCanal = "ativo" | "pausado" | "sem_estoque" | "inativo" | "nao_anunciado";

export interface AnuncioMl {
  item_id: string;
  status: string;
  sub_status: string;
  qtd_ml: number;
  preco_ml: number | null;
  listing_type: string;
  preco_alvo: number | null;
  div_qtd: boolean;
  div_preco: boolean;
  ultima_acao: string | null;
  acao_em: number | null;
  flex: 0 | 1 | null;
}

export interface ProdutoCanais {
  sku: string;
  produto: string | null;
  disp: number | null; // null = SKU não encontrado no Sankhya
  ativo_erp: boolean | null;
  preco_loja: number | null;
  canais: { ml: { situacao: SituacaoCanal; anuncios: AnuncioMl[] } };
}

export interface CanalInfo { id: string; nome: string; integrado: boolean }

export const CANAIS: CanalInfo[] = [
  { id: "ml", nome: "Mercado Livre", integrado: true },
  { id: "nuvemshop", nome: "Nuvemshop", integrado: false },
];

type LinhaAnuncio = AnuncioSync & { ultima_acao?: string | null; acao_em?: number | null };

const pausadoPorVoces = (a: { sub_status: string }) => String(a.sub_status).includes("paused_by_seller");

/** Situação do SKU no ML: basta um anúncio ativo para contar como "ativo". */
export function situacaoMl(anuncios: Array<{ status: string; sub_status: string }>): SituacaoCanal {
  if (!anuncios.length) return "nao_anunciado";
  if (anuncios.some((a) => a.status === "active")) return "ativo";
  if (anuncios.some(pausadoPorVoces)) return "pausado";
  if (anuncios.some((a) => String(a.sub_status).includes("out_of_stock"))) return "sem_estoque";
  return "inativo";
}

export function montarCatalogo(
  anuncios: LinhaAnuncio[],
  erp: Map<string, ErpSku>,
  semAnuncio: Array<{ sku: string; produto: string; disp: number; preco_loja: number | null }>,
  reguas: Reguas,
): ProdutoCanais[] {
  const porSku = new Map<string, ProdutoCanais>();
  const linha = (sku: string): ProdutoCanais => {
    let p = porSku.get(sku);
    if (!p) {
      const x = erp.get(sku);
      p = {
        sku, produto: x?.produto ?? null, disp: x ? Math.max(0, Math.floor(x.disp)) : null, ativo_erp: x ? x.ativo : null,
        preco_loja: x?.preco_loja ?? null, canais: { ml: { situacao: "nao_anunciado", anuncios: [] } },
      };
      porSku.set(sku, p);
    }
    return p;
  };
  for (const a of anuncios) {
    if (a.status === "closed") continue; // encerrado não é presença no canal
    const p = linha(a.sku || "(sem SKU)");
    const alvo = p.ativo_erp ? precoAlvo(p.preco_loja, a.listing_type, reguas) : null;
    p.canais.ml.anuncios.push({
      item_id: a.item_id, status: a.status, sub_status: a.sub_status, qtd_ml: a.qtd_ml, preco_ml: a.preco_ml,
      listing_type: a.listing_type, preco_alvo: alvo,
            // Pausado por vocês só é divergência se o ML tem mais do que o Sankhya (o hub só baixa).
      div_qtd: p.disp != null && (pausadoPorVoces(a) ? a.qtd_ml > p.disp : p.disp !== a.qtd_ml),
      div_preco: alvo != null && (p.disp ?? 0) > 0 && a.preco_ml != null && Math.abs(alvo - a.preco_ml) >= 0.01,
      ultima_acao: a.ultima_acao ?? null, acao_em: a.acao_em ?? null, flex: a.flex ?? null,
    });
  }
  for (const s of semAnuncio) {
    const p = linha(s.sku);
    p.produto ??= s.produto;
    if (p.disp == null) { p.disp = Math.max(0, Math.floor(s.disp)); p.ativo_erp = true; p.preco_loja = s.preco_loja; }
  }
  for (const p of porSku.values()) p.canais.ml.situacao = situacaoMl(p.canais.ml.anuncios);
  return [...porSku.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}
