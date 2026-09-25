// Configuração de negócio separada da lógica. Valores conferidos contra os 413
// pedidos 1090 que a Base gravou no Sankhya da Skyline (100% iguais, 24/09/2026)
// e contra a nota modelo da Base (NUNOTA 3560, TIPMOV 'Z').

export const CABECALHO_FIXO = {
  CODTIPOPER: "1090",
  CODTIPVENDA: "2",
  CODVEND: "9",
  CODEMP: "1",
  TIPMOV: "P",
  CODCENCUS: "130300",
  CODNAT: "1040000",
  // Da nota modelo 3560; presentes em 427 de 428 pedidos ML reais. A 1130 herda
  // e a transportadora sai no XML da NF-e (<transporta> MERCADO ENVIOS).
  TIPFRETE: "S",
  CODPARCTRANSP: "261", // TGFPAR 261 = MERCADO ENVIOS
} as const;

export const ITEM_FIXO = {
  // Em 24/09/2026 20:37 o Sankhya passou a controlar estoque por local
  // (TSIPAR UTILIZALOCAL N→S) e recusa o local 0 "<SEM LOCAL>" no pedido.
  // Local definido pelo Filipe em 25/09/2026: 10100000 (GERAL).
  CODLOCALORIG: "10100000",
  CODVOL: "UN",
  PERCDESC: "0",
} as const;

// Locais somados na leitura de estoque. O saldo físico ainda está no 0 e as vendas
// novas saem do 10100000 (que por isso fica negativo até a transferência): a soma
// dos dois é o disponível real. Quando o estoque for todo para o 10100000, o 0 zera
// e a soma continua certa.
export const LOCAIS_ESTOQUE = [0, 10100000] as const;

// Retry de eventos: backoff exponencial com jitter, teto de 6 h, 8 tentativas.
export const RETRY = {
  maxTentativas: 8,
  baseMs: 60_000,
  tetoMs: 6 * 60 * 60_000,
  lotePorCron: 20,
} as const;

export const TIMEOUT_MS = {
  meli: 15_000,
  sankhya: 30_000,
  sankhyaEscrita: 90_000, // gateway processa até 2 min; incluirNota pode demorar
} as const;

// Tópicos do ML que o webhook aceita. Só orders_v2 é processado nesta fase;
// os demais ficam registrados para as próximas (NF, etiqueta, reclamação).
export const TOPICOS_ACEITOS = new Set([
  "orders_v2",
  "shipments",
  "invoices",
  "post_purchase",
]);
