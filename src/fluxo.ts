// Fases do pedido no painel (módulo Pedidos). Função pura — testada em test/nota.test.ts.
//
//   novo      → venda recebida, ainda não está no Sankhya (aguardando pagamento/comissão ou pronta)
//   erp       → pedido 1090 no Sankhya, aguardando faturamento
//   faturado  → NF 1130 autorizada, XML ainda não aceito pelo ML
//   nf_ml     → XML aceito pelo ML, etiqueta liberada para imprimir
//   etiqueta  → etiqueta impressa, aguardando coleta
//   enviado   → envio saiu (shipped/delivered)
// Fora da esteira: atencao (bloqueado, divergente, erro de gravação ou de NF) e cancelado.

export const FASES = ["novo", "erp", "faturado", "nf_ml", "etiqueta", "enviado", "atencao", "cancelado"] as const;
export type Fase = (typeof FASES)[number];

export interface LinhaFluxo {
  situacao: string;
  gravacao: string | null;
  nunota: number | null;
  nf_status: string | null;
  nunota_nf: number | null;
  envio_status: string | null;
  envio_substatus: string | null;
}

export function fase(l: LinhaFluxo): Fase {
  if (l.situacao === "cancelado") return "cancelado";
  if (l.envio_status === "shipped" || l.envio_status === "delivered") return "enviado";
  if (l.envio_status === "ready_to_ship" && l.envio_substatus === "printed") return "etiqueta";
  if (l.nf_status === "enviado" || l.nf_status === "ja_no_ml") return "nf_ml";
  if (l.nf_status === "erro" || l.nf_status === "divergente") return "atencao";
  if (l.nunota_nf) return "faturado";
  if (l.gravacao === "erro" || l.situacao === "bloqueado" || l.situacao === "divergente") return "atencao";
  if (l.gravacao === "gravado" || l.situacao === "no_erp" || l.nunota) return "erp";
  return "novo";
}
