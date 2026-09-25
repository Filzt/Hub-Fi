// Checagem de cancelamento no bipe da Expedição.
//
// A estoquista bipa a etiqueta antes de despachar. Se a venda foi cancelada no ML
// depois da impressão, a caixa não pode sair. A lista de etiquetas do painel não
// serve para isso (envio cancelado sai dela), então aqui consultamos o ML AO VIVO,
// que é a fonte do status comercial, a cada bipe.
//
// Códigos aceitos: nº do envio (código grande da etiqueta, ~11 dígitos), QR da
// etiqueta ({"id":"<envio>",...}), nº do pedido/pack (16 dígitos), chave da NF
// (44 dígitos) ou número da NF (até 9 dígitos).

import { meliGet } from "./meli.ts";
import { sqlTexto } from "./nota.ts";
import { consultar } from "./sankhya.ts";
import { storeStub } from "./store.ts";
import { type Env, ErroDefinitivo } from "./tipos.ts";

type Order = { id: number | string; status?: string; pack_id?: number | string | null; shipping?: { id?: number | string | null } | null };
type Pack = { id: number | string; orders?: Array<{ id: number | string }>; shipment?: { id?: number | string | null } | null };
type Shipment = { id: number | string; status?: string; substatus?: string | null; order_id?: number | string | null; pack_id?: number | string | null };

export interface Checagem {
  codigo: string;
  encontrado: boolean;
  cancelado: boolean;
  motivo: string | null;
  pedido: string | null; // pack_id ou order_id
  shipment_id: string | null;
  envio_status: string | null;
  pedidos: Array<{ id: string; status: string }>;
  agendado: boolean; // pending/buffered: o ML só libera a etiqueta em `liberacao`
  liberacao: string | null;
}

const naoAchou = (e: unknown) => /HTTP 404/.test((e as Error).message);
async function talvez<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; } catch (e) { if (naoAchou(e)) return null; throw e; }
}

/** Extrai o número do QR da etiqueta ou os dígitos do código bipado. */
export function normalizarBipe(bruto: string): string {
  const t = String(bruto ?? "").trim();
  if (t.startsWith("{")) {
    try { const id = JSON.parse(t)?.id; if (id != null) return String(id).replace(/\D/g, ""); } catch { /* não é JSON */ }
  }
  return t.replace(/\D/g, "");
}

/** Pedido do ML (OBSERVACAO da 1130) a partir da chave ou do número da NF. */
async function pedidoPelaNf(env: Env, digitos: string): Promise<string | null> {
  const filtro = digitos.length === 44 ? `C.CHAVENFE = ${sqlTexto(digitos)}` : `C.NUMNOTA = ${Number(digitos)} AND C.CODEMP = 1`;
  const l = await consultar(env, `SELECT SUBSTR(C.OBSERVACAO, 1, 16) OBS FROM TGFCAB C WHERE C.CODTIPOPER = 1130 AND ${filtro} ORDER BY C.NUNOTA DESC`);
  const obs = String(l[0]?.OBS ?? "").trim();
  return /^\d{10,20}$/.test(obs) ? obs : null;
}

export async function checarBipe(env: Env, bruto: string): Promise<Checagem> {
  const codigo = normalizarBipe(bruto);
  if (!codigo) throw new ErroDefinitivo("código vazio");
  const r: Checagem = {
    codigo, encontrado: false, cancelado: false, motivo: null, pedido: null, shipment_id: null, envio_status: null, pedidos: [],
    agendado: false, liberacao: null,
  };

  let shipment: Shipment | null = null;
  let orderIds: string[] = [];
  let pedido: string | null = null;

  if (codigo.length === 44 || codigo.length <= 9) {
    pedido = await pedidoPelaNf(env, codigo);
  } else if (codigo.length >= 15) {
    pedido = codigo;
  } else {
    shipment = await talvez(meliGet<Shipment>(env, `/shipments/${codigo}`));
    if (shipment) pedido = shipment.pack_id ? String(shipment.pack_id) : shipment.order_id ? String(shipment.order_id) : null;
  }
  if (!pedido && !shipment) return r;

  // O número de 16 dígitos pode ser order ou pack: tenta order e, se não for, pack.
  if (pedido) {
    const order = await talvez(meliGet<Order>(env, `/orders/${pedido}`));
    const packId = order?.pack_id ? String(order.pack_id) : order ? null : pedido;
    const pack = packId ? await talvez(meliGet<Pack>(env, `/packs/${packId}`)) : null;
    if (pack) {
      orderIds = (pack.orders ?? []).map((o) => String(o.id));
      pedido = String(pack.id);
      if (!shipment && pack.shipment?.id) shipment = await talvez(meliGet<Shipment>(env, `/shipments/${pack.shipment.id}`));
    } else if (order) {
      orderIds = [String(order.id)];
      if (!shipment && order.shipping?.id) shipment = await talvez(meliGet<Shipment>(env, `/shipments/${order.shipping.id}`));
    }
  }
  for (const id of orderIds) {
    const o = await talvez(meliGet<Order>(env, `/orders/${id}`));
    if (o) r.pedidos.push({ id, status: String(o.status ?? "") });
  }

  r.encontrado = r.pedidos.length > 0 || !!shipment;
  r.pedido = pedido;
  r.shipment_id = shipment ? String(shipment.id) : null;
  r.envio_status = shipment ? [shipment.status, shipment.substatus].filter(Boolean).join(" / ") : null;

  // Qualquer pedido do carrinho cancelado já barra: o conteúdo da caixa mudou.
  const cancelados = r.pedidos.filter((p) => p.status === "cancelled");
  if (cancelados.length) {
    r.cancelado = true;
    r.motivo = cancelados.length === r.pedidos.length ? "venda cancelada no Mercado Livre"
      : `${cancelados.length} de ${r.pedidos.length} pedidos do carrinho cancelados (${cancelados.map((p) => p.id).join(", ")})`;
  } else if (shipment?.status === "cancelled") {
    r.cancelado = true;
    r.motivo = "envio cancelado no Mercado Livre";
  }
  if (!r.cancelado && shipment?.status === "pending" && shipment.substatus === "buffered") {
    r.agendado = true;
    const lt = await talvez(meliGet<{ buffering?: { date?: string | null } | null }>(env, `/shipments/${shipment.id}/lead_time`));
    r.liberacao = lt?.buffering?.date ?? null;
  }
  if (r.cancelado) await storeStub(env).log("aviso", pedido, `bipe na expedição de pedido CANCELADO (${codigo}): ${r.motivo}`);
  return r;
}
