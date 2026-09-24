// Funções puras: consolidam o pedido do ML e montam o corpo do CACSP.incluirNota.
// Sem I/O — testadas em test/nota.test.ts.

import { CABECALHO_FIXO, ITEM_FIXO } from "./config.ts";

/** Pedido do ML reduzido ao que a integração usa (GET /orders/{id}). */
export interface OrderML {
  id: number | string;
  status: string;
  pack_id?: number | string | null;
  date_created: string;
  total_amount?: number;
  shipping?: { id?: number | string | null } | null;
  buyer?: { billing_info?: { id?: string | null } | null } | null;
  order_items: Array<{
    item: { id: string; seller_sku?: string | null; variation_id?: number | null };
    quantity: number;
    unit_price: number;
    sale_fee?: number | null;
  }>;
}

export interface ItemConsolidado {
  orderId: string;
  itemId: string;
  sku: string;
  quantidade: number;
  precoCentavos: number;
  /**
   * sale_fee do ML × quantidade. sale_fee é POR UNIDADE — confirmado em 24/09/2026
   * num pedido com quantidade 2 (81,86 = 11,0% do preço unitário, mesma taxa dos demais).
   */
  comissaoCentavos: number;
}

export interface PedidoConsolidado {
  chave: string; // pack_id quando existe, senão order_id
  orderIds: string[];
  status: string[]; // status de cada order do pack
  dataCriacao: string; // ISO do mais antigo
  shippingId: string | null;
  billingInfoId: string | null;
  itens: ItemConsolidado[];
  totalCentavos: number;
  comissaoCentavos: number;
  alertas: string[];
}

export const centavos = (v: number): number => Math.round(Number(v) * 100);
export const reais = (c: number): string => (c / 100).toFixed(2);

export function soDigitos(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

/** SKU aceito em SQL: só letras, dígitos e . _ - (evita injeção no executeQuery). */
export function skuValido(sku: string): boolean {
  return /^[A-Za-z0-9._-]{1,40}$/.test(sku);
}

/** Literal SQL seguro para valores já validados. */
export function sqlTexto(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** DD/MM/AAAA no fuso de São Paulo (DTNEG). */
export function dataSaoPaulo(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`data inválida: ${iso}`);
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

/** Junta as orders de um pack (ou uma order avulsa) num pedido só. */
export function consolidar(orders: OrderML[]): PedidoConsolidado {
  if (!orders.length) throw new Error("nenhuma order para consolidar");
  const alertas: string[] = [];
  const packId = orders[0].pack_id ? String(orders[0].pack_id) : null;
  const itens: ItemConsolidado[] = [];

  for (const o of orders) {
    for (const oi of o.order_items) {
      const sku = String(oi.item.seller_sku ?? "").trim();
      if (!sku) alertas.push(`order ${o.id}: item ${oi.item.id} sem SELLER_SKU`);
      else if (!skuValido(sku)) alertas.push(`order ${o.id}: SKU com caractere inválido: ${sku}`);
      const qtd = Number(oi.quantity);
      itens.push({
        orderId: String(o.id),
        itemId: oi.item.id,
        sku,
        quantidade: qtd,
        precoCentavos: centavos(oi.unit_price),
        comissaoCentavos: centavos(oi.sale_fee ?? 0) * qtd,
      });
    }
  }

  const envios = new Set(orders.map((o) => o.shipping?.id).filter(Boolean).map(String));
  if (envios.size > 1) alertas.push(`pack com ${envios.size} envios distintos`);
  const billing = new Set(
    orders.map((o) => o.buyer?.billing_info?.id).filter(Boolean).map(String),
  );
  if (billing.size > 1) alertas.push("pack com mais de um billing_info");

  const datas = orders.map((o) => o.date_created).sort();
  return {
    chave: packId ?? String(orders[0].id),
    orderIds: orders.map((o) => String(o.id)),
    status: orders.map((o) => o.status),
    dataCriacao: datas[0],
    shippingId: envios.size ? [...envios][0] : null,
    billingInfoId: billing.size ? [...billing][0] : null,
    itens,
    totalCentavos: itens.reduce((s, i) => s + i.precoCentavos * i.quantidade, 0),
    comissaoCentavos: itens.reduce((s, i) => s + i.comissaoCentavos, 0),
    alertas,
  };
}

/** Valor que o ML cobra do vendedor pelo envio (GET /shipments/{id}/costs). */
export function freteVendedorCentavos(
  costs: { senders?: Array<{ user_id?: number | string; cost?: number }> } | null,
  userId: string,
): number {
  const senders = costs?.senders ?? [];
  const nosso = senders.find((s) => String(s.user_id) === userId);
  return centavos((nosso ?? senders[0])?.cost ?? 0);
}

export interface EntradaNota {
  codparc: number;
  dtneg: string; // DD/MM/AAAA
  observacao: string; // nº do ML puro
  comissaoCentavos: number;
  freteCentavos: number;
  itens: Array<{ codprod: number; quantidade: number; precoCentavos: number }>;
}

/** Corpo do CACSP.incluirNota, no formato do template da Skyline. */
export function montarNota(e: EntradaNota) {
  if (!e.itens.length) throw new Error("nota sem itens");
  const v = (x: string | number) => ({ $: String(x) });
  const cab: Record<string, unknown> = {
    NUNOTA: {},
    CODPARC: v(e.codparc),
    DTNEG: v(e.dtneg),
  };
  for (const [k, x] of Object.entries(CABECALHO_FIXO)) cab[k] = v(x);
  cab.OBSERVACAO = v(e.observacao);
  cab.AD_VLRCOMISSAO = v(reais(e.comissaoCentavos));
  cab.AD_FRETEMKTP = v(reais(e.freteCentavos));

  return {
    serviceName: "CACSP.incluirNota",
    requestBody: {
      nota: {
        cabecalho: cab,
        itens: {
          INFORMARPRECO: "True",
          item: e.itens.map((i) => ({
            NUNOTA: {},
            IGNOREDESCPROMOQTD: v("True"),
            CODPROD: v(i.codprod),
            QTDNEG: v(i.quantidade),
            CODLOCALORIG: v(ITEM_FIXO.CODLOCALORIG),
            CODVOL: v(ITEM_FIXO.CODVOL),
            PERCDESC: v(ITEM_FIXO.PERCDESC),
            VLRUNIT: v(reais(i.precoCentavos)),
          })),
        },
      },
    },
  };
}

export interface DocBase {
  NUNOTA: number;
  CODTIPOPER: number;
  OBSERVACAO: string;
  VLRNOTA: number | null;
  AD_VLRCOMISSAO: number | null;
  CODPARC: number | null;
  itens: Array<{ CODPROD: number; QTDNEG: number; VLRUNIT: number }>;
}

/** Diferenças entre o que o Worker montaria e o pedido 1090 que a Base gravou. */
export function compararComBase(
  nota: EntradaNota,
  base: DocBase[],
): { encontrado: boolean; nunotas: number[]; divergencias: string[] } {
  const pedidos = base.filter((d) => Number(d.CODTIPOPER) === 1090);
  if (!pedidos.length) return { encontrado: false, nunotas: [], divergencias: [] };
  const div: string[] = [];
  if (pedidos.length > 1) div.push(`Base gravou ${pedidos.length} pedidos 1090 para este pack`);

  const chaveItem = (codprod: number, qtd: number, c: number) => `${codprod}|${qtd}|${c}`;
  const nossos = nota.itens.map((i) => chaveItem(i.codprod, i.quantidade, i.precoCentavos)).sort();
  const deles = pedidos
    .flatMap((d) => d.itens)
    .map((i) => chaveItem(Number(i.CODPROD), Number(i.QTDNEG), centavos(i.VLRUNIT)))
    .sort();
  if (nossos.join() !== deles.join()) {
    div.push(`itens diferem — Worker [${nossos.join("; ")}] × Base [${deles.join("; ")}]`);
  }

  const parcs = new Set(pedidos.map((d) => Number(d.CODPARC)));
  if (!parcs.has(nota.codparc)) div.push(`CODPARC ${nota.codparc} × Base ${[...parcs].join(",")}`);

  const comBase = pedidos.reduce((s, d) => s + centavos(d.AD_VLRCOMISSAO ?? 0), 0);
  const algumaComissao = pedidos.some((d) => d.AD_VLRCOMISSAO != null);
  if (algumaComissao && comBase !== nota.comissaoCentavos) {
    div.push(`comissão ${reais(nota.comissaoCentavos)} × Base ${reais(comBase)}`);
  }
  return { encontrado: true, nunotas: pedidos.map((d) => Number(d.NUNOTA)), divergencias: div };
}

// ---------------------------------------------------------------------------
// Parceiro (TGFPAR) a partir do billing-info do ML
// ---------------------------------------------------------------------------

/** GET /orders/billing-info/MLB/{id} → buyer.billing_info (formato visto em 24/09/2026). */
export interface BillingML {
  name?: string | null;
  last_name?: string | null;
  identification?: { type?: string | null; number?: string | null } | null;
  taxes?: { inscriptions?: { state_registration?: string | null } | null } | null;
  address?: {
    street_name?: string | null;
    street_number?: string | null;
    comment?: string | null;
    zip_code?: string | null;
  } | null;
}

/** Linha da TSICEP: o Sankhya tem a base nacional de CEP (1,47 mi, todos com CODEND). */
export interface CepSankhya {
  CODEND: number;
  CODBAI: number;
  CODCID: number;
}

// Tamanhos de TGFPAR (ALL_TAB_COLUMNS, 24/09/2026).
const TAM = { NOMEPARC: 100, NUMEND: 6, COMPLEMENTO: 30, IDENTINSCESTAD: 16, CEP: 8 } as const;

/**
 * Campos do parceiro no padrão dos 555 que a Base criou: nome em maiúsculas,
 * razão social como veio, "SN" sem número, CLIENTE='S', CLASSIFICMS='C'.
 * Nunca trunca nome, documento nem IE — nesses casos bloqueia.
 */
export function montarParceiro(
  b: BillingML | null,
  cep: CepSankhya | null,
): { campos: Record<string, string> | null; bloqueio: string | null; alertas: string[] } {
  const alertas: string[] = [];
  const falha = (m: string) => ({ campos: null, bloqueio: m, alertas });
  if (!b) return falha("billing-info vazio");

  const doc = soDigitos(b.identification?.number);
  const tipoDoc = String(b.identification?.type ?? "").toUpperCase();
  const tippessoa = tipoDoc === "CNPJ" || doc.length === 14 ? "J" : tipoDoc === "CPF" || doc.length === 11 ? "F" : "";
  if (!tippessoa || (tippessoa === "F" && doc.length !== 11) || (tippessoa === "J" && doc.length !== 14)) {
    return falha(`documento do comprador inválido (${tipoDoc || "sem tipo"}, ${doc.length} dígitos)`);
  }

  const nome = [b.name, b.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
  if (!nome) return falha("comprador sem nome no billing-info");
  if (nome.length > TAM.NOMEPARC) return falha(`nome com ${nome.length} caracteres (máx. ${TAM.NOMEPARC})`);

  const cepDig = soDigitos(b.address?.zip_code);
  if (cepDig.length !== TAM.CEP) return falha(`CEP inválido no billing-info (${cepDig || "vazio"})`);
  if (!cep) return falha(`CEP ${cepDig} não encontrado na TSICEP`);

  let numero = String(b.address?.street_number ?? "").trim();
  let complemento = String(b.address?.comment ?? "").trim().replace(/\s+/g, " ");
  if (!numero || /^s\/?n$/i.test(numero)) numero = "SN";
  if (numero.length > TAM.NUMEND) {
    alertas.push(`número "${numero}" não cabe em NUMEND (${TAM.NUMEND}); foi para o complemento`);
    complemento = `Nº ${numero}${complemento ? " " + complemento : ""}`;
    numero = "SN";
  }
  if (complemento.length > TAM.COMPLEMENTO) {
    alertas.push(`complemento cortado em ${TAM.COMPLEMENTO} caracteres`);
    complemento = complemento.slice(0, TAM.COMPLEMENTO).trim();
  }

  const campos: Record<string, string> = {
    NOMEPARC: nome.toUpperCase(),
    RAZAOSOCIAL: nome,
    TIPPESSOA: tippessoa,
    CGC_CPF: doc,
    CEP: cepDig,
    CODEND: String(cep.CODEND),
    CODBAI: String(cep.CODBAI),
    CODCID: String(cep.CODCID),
    NUMEND: numero,
    CLIENTE: "S",
    CLASSIFICMS: "C",
    ATIVO: "S",
  };
  if (complemento) campos.COMPLEMENTO = complemento;

  const ie = String(b.taxes?.inscriptions?.state_registration ?? "").trim();
  if (ie && !/^isento$/i.test(ie)) {
    if (ie.length > TAM.IDENTINSCESTAD) return falha(`IE com ${ie.length} caracteres (máx. ${TAM.IDENTINSCESTAD}) — nunca truncar`);
    campos.IDENTINSCESTAD = ie;
  }
  return { campos, bloqueio: null, alertas };
}
