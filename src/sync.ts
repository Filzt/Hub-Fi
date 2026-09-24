// Planejamento da sincronização de estoque e preço ERP → ML. Funções puras
// (testadas em test/nota.test.ts); quem lê e escreve é estoque.ts.
//
// Regras (decididas com o Filipe em 24/09/2026):
//   quantidade = ESTOQUE − RESERVADO no Sankhya (empresa 1, local 0), por SKU do
//                anúncio; negativo ou produto inativo = 0;
//   preço      = preço de loja (tabela 0, vigência mais recente) × 1,1236 + 70 no
//                Clássico — a régua que já estava no ar (a da Base);
//   nunca mexe em anúncio pausado pelo vendedor (paused_by_seller) nem em
//   anúncio fora de active/paused.

export type Reguas = Record<string, { fator: number; soma: number }>;

/** Régua padrão (usada enquanto o time não salvar outra na Precificação). */
export const REGUA_PRECO: Reguas = {
  gold_special: { fator: 1.1236, soma: 70 }, // Clássico
  gold_pro: { fator: 1.2, soma: 70 }, // Premium (nenhum anúncio hoje)
};

/** Variação máxima de preço aceita numa rodada; acima disso vira alerta (dado suspeito). */
export const LIMITE_VARIACAO_PRECO = 0.25;

export interface AnuncioSync {
  item_id: string;
  sku: string;
  status: string;
  sub_status: string; // separado por vírgula
  qtd_ml: number;
  preco_ml: number | null;
  listing_type: string;
}

export interface ErpSku {
  disp: number;
  ativo: boolean;
  preco_loja: number | null;
}

export interface Acao {
  item_id: string;
  sku: string;
  qtd_de: number;
  qtd_para: number | null; // null = não muda
  preco_de: number | null;
  preco_para: number | null; // null = não muda
  motivo: string;
}

export function precoAlvo(loja: number | null, tipo: string, reguas: Reguas = REGUA_PRECO): number | null {
  const r = reguas[tipo];
  if (!r || loja == null || !(loja > 0)) return null;
  return Math.round((loja * r.fator + r.soma) * 100) / 100;
}

export function planejar(
  anuncios: AnuncioSync[],
  erp: Map<string, ErpSku>,
  reguas: Reguas = REGUA_PRECO,
): { acoes: Acao[]; alertas: string[]; ignorados: number } {
  const acoes: Acao[] = [];
  const alertas: string[] = [];
  let ignorados = 0;

  // SKU com mais de um anúncio: o de menor item_id recebe o saldo, os outros 0
  // (mesmo aparelho em dois anúncios = risco de vender a mesma unidade duas vezes).
  const porSku = new Map<string, string[]>();
  for (const a of anuncios) porSku.set(a.sku, [...(porSku.get(a.sku) ?? []), a.item_id]);
  for (const [sku, ids] of porSku) {
    if (sku && ids.length > 1) alertas.push(`SKU ${sku} em ${ids.length} anúncios (${ids.sort().join(", ")}) — saldo só no primeiro`);
  }

  for (const a of anuncios) {
    if (a.status !== "active" && a.status !== "paused") { ignorados++; continue; }
    if (a.sub_status.split(",").map((s) => s.trim()).includes("paused_by_seller")) { ignorados++; continue; }
    if (!a.sku) { alertas.push(`${a.item_id} sem SELLER_SKU`); ignorados++; continue; }
    const x = erp.get(a.sku);
    if (!x) { alertas.push(`${a.item_id}: SKU ${a.sku} não existe no Sankhya — não mexo`); ignorados++; continue; }

    const primeiro = (porSku.get(a.sku) ?? [a.item_id]).slice().sort()[0] === a.item_id;
    const disp = !x.ativo ? 0 : primeiro ? Math.max(0, Math.floor(x.disp)) : 0;
    const qtdPara = disp !== a.qtd_ml ? disp : null;

    let precoPara: number | null = null;
    const alvo = disp > 0 ? precoAlvo(x.preco_loja, a.listing_type, reguas) : null;
    if (alvo != null && (a.preco_ml == null || Math.abs(alvo - a.preco_ml) >= 0.01)) {
      if (a.preco_ml && Math.abs(alvo / a.preco_ml - 1) > LIMITE_VARIACAO_PRECO) {
        alertas.push(`${a.item_id} (${a.sku}): preço ${a.preco_ml} → ${alvo} passa de ${LIMITE_VARIACAO_PRECO * 100}% — não aplico`);
      } else {
        precoPara = alvo;
      }
    }
    if (qtdPara == null && precoPara == null) continue;

    const motivos: string[] = [];
    if (qtdPara != null) motivos.push(qtdPara === 0 ? "zerar" : a.qtd_ml === 0 ? "repor" : qtdPara > a.qtd_ml ? "subir" : "baixar");
    if (!x.ativo && qtdPara != null) motivos.push("produto inativo");
    if (!primeiro && qtdPara != null) motivos.push("SKU duplicado");
    if (precoPara != null) motivos.push("preço");
    acoes.push({ item_id: a.item_id, sku: a.sku, qtd_de: a.qtd_ml, qtd_para: qtdPara, preco_de: a.preco_ml, preco_para: precoPara, motivo: motivos.join(", ") });
  }
  return { acoes, alertas, ignorados };
}

/**
 * Trava contra "leitura falhou → escreve zero" (o erro que derrubou a Base).
 * Devolve o motivo para abortar a rodada inteira, ou null.
 */
export function motivoParaAbortar(
  acoes: Acao[],
  ctx: { skusPedidos: number; skusLidos: number; comSaldo: number; comSaldoAnterior: number | null; maxZerar: number },
): string | null {
  if (ctx.skusPedidos > 0 && ctx.skusLidos < ctx.skusPedidos * 0.5) {
    return `Sankhya devolveu ${ctx.skusLidos} de ${ctx.skusPedidos} SKUs — leitura suspeita`;
  }
  const zerar = acoes.filter((a) => a.qtd_para === 0).length;
  if (zerar > ctx.maxZerar) return `${zerar} anúncios seriam zerados de uma vez (limite ${ctx.maxZerar}) — provável leitura errada`;
  if (ctx.comSaldoAnterior && ctx.comSaldoAnterior >= 20 && ctx.comSaldo < ctx.comSaldoAnterior * 0.5) {
    return `SKUs com saldo caíram de ${ctx.comSaldoAnterior} para ${ctx.comSaldo} desde a última rodada`;
  }
  return null;
}

/** Limites aceitos ao salvar régua pelo painel (protege contra digitação errada). */
export const LIMITES_REGUA = { fatorMin: 1, fatorMax: 2, somaMin: 0, somaMax: 500 } as const;

export function validarReguas(r: unknown): { ok: true; reguas: Reguas } | { ok: false; erro: string } {
  if (!r || typeof r !== "object") return { ok: false, erro: "réguas ausentes" };
  const out: Reguas = {};
  for (const tipo of Object.keys(REGUA_PRECO)) {
    const v = (r as Record<string, { fator?: unknown; soma?: unknown }>)[tipo];
    const fator = Number(v?.fator), soma = Number(v?.soma);
    if (!Number.isFinite(fator) || fator < LIMITES_REGUA.fatorMin || fator > LIMITES_REGUA.fatorMax) {
      return { ok: false, erro: `${tipo}: fator deve ficar entre ${LIMITES_REGUA.fatorMin} e ${LIMITES_REGUA.fatorMax}` };
    }
    if (!Number.isFinite(soma) || soma < LIMITES_REGUA.somaMin || soma > LIMITES_REGUA.somaMax) {
      return { ok: false, erro: `${tipo}: acréscimo deve ficar entre R$ ${LIMITES_REGUA.somaMin} e R$ ${LIMITES_REGUA.somaMax}` };
    }
    out[tipo] = { fator: Math.round(fator * 10000) / 10000, soma: Math.round(soma * 100) / 100 };
  }
  return { ok: true, reguas: out };
}

/** Impacto de uma régua nova sobre os anúncios com saldo (prévia antes de salvar). */
export function simularReguas(
  anuncios: AnuncioSync[],
  erp: Map<string, ErpSku>,
  reguas: Reguas,
): { avaliados: number; mudam: number; sobem: number; descem: number; bloqueados: number; variacaoMedia: number; exemplos: Array<{ item_id: string; sku: string; de: number; para: number }> } {
  let avaliados = 0, mudam = 0, sobem = 0, descem = 0, bloqueados = 0, somaVar = 0;
  const exemplos: Array<{ item_id: string; sku: string; de: number; para: number }> = [];
  for (const a of anuncios) {
    const x = erp.get(a.sku);
    if (!x || !x.ativo || x.disp <= 0 || !a.preco_ml) continue;
    const alvo = precoAlvo(x.preco_loja, a.listing_type, reguas);
    if (alvo == null) continue;
    avaliados++;
    if (Math.abs(alvo - a.preco_ml) < 0.01) continue;
    const variacao = alvo / a.preco_ml - 1;
    if (Math.abs(variacao) > LIMITE_VARIACAO_PRECO) { bloqueados++; continue; }
    mudam++; somaVar += variacao;
    if (alvo > a.preco_ml) sobem++; else descem++;
    if (exemplos.length < 8) exemplos.push({ item_id: a.item_id, sku: a.sku, de: a.preco_ml, para: alvo });
  }
  return { avaliados, mudam, sobem, descem, bloqueados, variacaoMedia: mudam ? Math.round((somaVar / mudam) * 10000) / 100 : 0, exemplos };
}
