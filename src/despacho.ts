// Momento do despacho (fase 3 da Expedição) a partir do histórico do envio no ML.

export interface EnvioHistorico {
  status?: string;
  status_history?: { date_shipped?: string | null } | null;
  substatus_history?: Array<{ date?: string; substatus?: string; status?: string }> | null;
}

// Bipe na agência/coleta, conferido no histórico real do envio 48087582754 (25/09/2026):
// ready_to_print → dropped_off (agência) → picked_up → in_hub → in_packing_list → shipped.
const SUBSTATUS_DESPACHO = new Set(["dropped_off", "picked_up"]);

/**
 * Quando o pacote saiu da nossa mão, pelo histórico do ML: 1º dropped_off/picked_up;
 * sem isso (outra logística), a data de shipped. 0 = despachado sem data conhecida;
 * null = ainda não despachado.
 */
export function despachoDoEnvio(s: EnvioHistorico): number | null {
  const marcos = (s.substatus_history ?? [])
    .filter((h) => SUBSTATUS_DESPACHO.has(String(h.substatus ?? "")) && h.date)
    .map((h) => Date.parse(String(h.date)))
    .filter(Number.isFinite);
  if (marcos.length) return Math.min(...marcos);
  const enviado = Date.parse(String(s.status_history?.date_shipped ?? ""));
  if (Number.isFinite(enviado)) return enviado;
  return ["shipped", "delivered", "not_delivered"].includes(String(s.status ?? "")) ? 0 : null;
}
