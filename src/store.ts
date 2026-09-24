// Estado da integração num Durable Object com SQLite (instância única "principal").
// Tabelas: eventos (fila com retry), pedidos (resultado da sombra), log.

import { DurableObject } from "cloudflare:workers";
import { RETRY } from "./config.ts";
import type { Env } from "./tipos.ts";

export type SituacaoEvento = "pendente" | "ok" | "erro" | "ignorado";

export type Evento = {
  id: number;
  topic: string;
  resource: string;
  recebido_em: number;
  tentativas: number;
  status: SituacaoEvento;
  proximo_em: number;
  erro: string | null;
};

export type Pedido = {
  chave: string;
  order_ids: string;
  data_ml: string;
  status_ml: string;
  situacao: string; // pronto | no_erp | divergente | bloqueado | cancelado | aguardando_pagamento
  total: number;
  comissao: number;
  frete: number;
  codparc: number | null;
  nunotas_base: string | null;
  nota_json: string | null;
  analise_json: string;
  atualizado_em: number;
};

/** Estado da gravação no Sankhya, guardado à parte da análise (que é refeita a cada evento). */
export type Gravacao = {
  nunota: number | null;
  gravacao: string | null; // gravando | gravado | erro
  gravacao_em: number | null;
  gravacao_erro: string | null;
};

/** Envio do XML da NF-e ao ML, por pedido (chave = pack_id ou order_id). */
export type Nf = {
  chave: string;
  nunota_nf: number;
  shipment_id: string | null;
  logistica: string | null;
  fiscal_key: string | null;
  // pronto | enviado | ja_no_ml | aguardando_ml | divergente | nao_se_aplica | cancelado | erro
  status: string;
  detalhe: string | null;
  tentativas: number;
  atualizado_em: number;
};

export class Store extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS eventos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        resource TEXT NOT NULL,
        recebido_em INTEGER NOT NULL,
        tentativas INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pendente',
        proximo_em INTEGER NOT NULL,
        erro TEXT,
        UNIQUE(topic, resource)
      );
      CREATE INDEX IF NOT EXISTS ix_eventos_fila ON eventos(status, proximo_em);
      CREATE TABLE IF NOT EXISTS pedidos (
        chave TEXT PRIMARY KEY,
        order_ids TEXT NOT NULL,
        data_ml TEXT NOT NULL,
        status_ml TEXT NOT NULL,
        situacao TEXT NOT NULL,
        total REAL NOT NULL,
        comissao REAL NOT NULL,
        frete REAL NOT NULL,
        codparc INTEGER,
        nunotas_base TEXT,
        nota_json TEXT,
        analise_json TEXT NOT NULL,
        atualizado_em INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_pedidos_data ON pedidos(data_ml);
      CREATE TABLE IF NOT EXISTS nfs (
        chave TEXT PRIMARY KEY,
        nunota_nf INTEGER NOT NULL,
        shipment_id TEXT,
        logistica TEXT,
        fiscal_key TEXT,
        status TEXT NOT NULL,
        detalhe TEXT,
        tentativas INTEGER NOT NULL DEFAULT 0,
        atualizado_em INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS travas (
        nome TEXT PRIMARY KEY,
        ate INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        em INTEGER NOT NULL,
        nivel TEXT NOT NULL,
        chave TEXT,
        msg TEXT NOT NULL
      );
    `);
    // Migração: colunas de gravação (SQLite não tem ADD COLUMN IF NOT EXISTS).
    const cols = new Set(this.sql.exec<{ name: string }>(`PRAGMA table_info(pedidos)`).toArray().map((c) => c.name));
    for (const [nome, tipo] of [["nunota", "INTEGER"], ["gravacao", "TEXT"], ["gravacao_em", "INTEGER"], ["gravacao_erro", "TEXT"],
                                ["cancelamento", "TEXT"], ["cancelamento_em", "INTEGER"]]) {
      if (!cols.has(nome)) this.sql.exec(`ALTER TABLE pedidos ADD COLUMN ${nome} ${tipo}`);
    }
  }

  /**
   * Trava nomeada com validade. O Durable Object é single-thread, então
   * checar-e-gravar aqui é atômico. Devolve false se já está travado.
   */
  travar(nome: string, ttlMs: number): boolean {
    const agora = Date.now();
    this.sql.exec(`DELETE FROM travas WHERE ate < ?`, agora);
    const c = this.sql.exec(`INSERT OR IGNORE INTO travas (nome, ate) VALUES (?, ?)`, nome, agora + ttlMs);
    return c.rowsWritten > 0;
  }

  destravar(nome: string): void {
    this.sql.exec(`DELETE FROM travas WHERE nome = ?`, nome);
  }

  gravacao(chave: string): Gravacao | null {
    return (
      this.sql
        .exec<Gravacao>(`SELECT nunota, gravacao, gravacao_em, gravacao_erro FROM pedidos WHERE chave = ?`, chave)
        .toArray()[0] ?? null
    );
  }

  marcarGravacao(chave: string, estado: "gravando" | "gravado" | "erro", dados: { nunota?: number | null; erro?: string } = {}): void {
    this.sql.exec(
      `UPDATE pedidos SET gravacao = ?, gravacao_em = ?, nunota = COALESCE(?, nunota), gravacao_erro = ? WHERE chave = ?`,
      estado, Date.now(), dados.nunota ?? null, estado === "erro" ? (dados.erro ?? "").slice(0, 1000) : null, chave,
    );
  }

  nf(chave: string): Nf | null {
    return this.sql.exec<Nf>(`SELECT * FROM nfs WHERE chave = ?`, chave).toArray()[0] ?? null;
  }

  salvarNf(n: Omit<Nf, "tentativas" | "atualizado_em">, somarTentativa = false): void {
    this.sql.exec(
      `INSERT INTO nfs (chave, nunota_nf, shipment_id, logistica, fiscal_key, status, detalhe, tentativas, atualizado_em)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(chave) DO UPDATE SET nunota_nf=excluded.nunota_nf, shipment_id=excluded.shipment_id,
         logistica=excluded.logistica, fiscal_key=excluded.fiscal_key, status=excluded.status,
         detalhe=excluded.detalhe, tentativas=nfs.tentativas + excluded.tentativas, atualizado_em=excluded.atualizado_em`,
      n.chave, n.nunota_nf, n.shipment_id, n.logistica, n.fiscal_key, n.status, (n.detalhe ?? "").slice(0, 1000),
      somarTentativa ? 1 : 0, Date.now(),
    );
  }

  listarNfs(limite = 200): Nf[] {
    return this.sql.exec<Nf>(`SELECT * FROM nfs ORDER BY atualizado_em DESC LIMIT ?`, limite).toArray();
  }

  /** Resultado do cancelamento no ERP (texto curto: "cancelado: ...", "faturado: ..."). */
  marcarCancelamento(chave: string, texto: string): void {
    this.sql.exec(`UPDATE pedidos SET cancelamento = ?, cancelamento_em = ? WHERE chave = ?`, texto.slice(0, 500), Date.now(), chave);
  }

  /**
   * Registra (ou reabre) um evento. O ML reenvia o mesmo resource a cada mudança
   * do pedido, então a mesma chave volta para 'pendente' em vez de duplicar.
   */
  registrarEvento(topic: string, resource: string): number {
    const agora = Date.now();
    const row = this.sql
      .exec<{ id: number }>(
        `INSERT INTO eventos (topic, resource, recebido_em, proximo_em)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(topic, resource) DO UPDATE SET
           status = CASE WHEN status = 'ignorado' THEN 'ignorado' ELSE 'pendente' END,
           tentativas = 0, recebido_em = excluded.recebido_em, proximo_em = excluded.proximo_em, erro = NULL
         RETURNING id`,
        topic, resource, agora, agora,
      )
      .one();
    return row.id;
  }

  ignorarEvento(id: number, motivo: string): void {
    this.sql.exec(`UPDATE eventos SET status='ignorado', erro=? WHERE id=?`, motivo, id);
  }

  evento(id: number): Evento | null {
    return this.sql.exec<Evento>(`SELECT * FROM eventos WHERE id=?`, id).toArray()[0] ?? null;
  }

  eventosDevidos(limite = RETRY.lotePorCron): Evento[] {
    return this.sql
      .exec<Evento>(
        `SELECT * FROM eventos WHERE status IN ('pendente','erro') AND tentativas < ? AND proximo_em <= ?
         ORDER BY proximo_em LIMIT ?`,
        RETRY.maxTentativas, Date.now(), limite,
      )
      .toArray();
  }

  /** ok=true fecha; temporario=true agenda retry com backoff; senão erro definitivo. */
  concluirEvento(id: number, r: { ok: boolean; temporario?: boolean; erro?: string }): void {
    if (r.ok) {
      this.sql.exec(`UPDATE eventos SET status='ok', erro=NULL, tentativas=tentativas+1 WHERE id=?`, id);
      return;
    }
    const ev = this.evento(id);
    const tent = (ev?.tentativas ?? 0) + 1;
    const esgotou = !r.temporario || tent >= RETRY.maxTentativas;
    const espera = Math.min(RETRY.baseMs * 2 ** (tent - 1), RETRY.tetoMs);
    const jitter = Math.floor(Math.random() * espera * 0.2);
    this.sql.exec(
      `UPDATE eventos SET status='erro', tentativas=?, proximo_em=?, erro=? WHERE id=?`,
      esgotou ? RETRY.maxTentativas : tent,
      Date.now() + espera + jitter,
      (r.erro ?? "").slice(0, 1000),
      id,
    );
  }

  reabrirEvento(id: number): void {
    this.sql.exec(`UPDATE eventos SET status='pendente', tentativas=0, proximo_em=?, erro=NULL WHERE id=?`, Date.now(), id);
  }

  listarEventos(status: string | null, limite = 200): Evento[] {
    return status
      ? this.sql.exec<Evento>(`SELECT * FROM eventos WHERE status=? ORDER BY id DESC LIMIT ?`, status, limite).toArray()
      : this.sql.exec<Evento>(`SELECT * FROM eventos ORDER BY id DESC LIMIT ?`, limite).toArray();
  }

  /** Upsert da análise — preserva as colunas de gravação. */
  salvarPedido(p: Pedido): void {
    this.sql.exec(
      `INSERT INTO pedidos
       (chave, order_ids, data_ml, status_ml, situacao, total, comissao, frete, codparc,
        nunotas_base, nota_json, analise_json, atualizado_em)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(chave) DO UPDATE SET
         order_ids=excluded.order_ids, data_ml=excluded.data_ml, status_ml=excluded.status_ml,
         situacao=excluded.situacao, total=excluded.total, comissao=excluded.comissao, frete=excluded.frete,
         codparc=excluded.codparc, nunotas_base=excluded.nunotas_base, nota_json=excluded.nota_json,
         analise_json=excluded.analise_json, atualizado_em=excluded.atualizado_em`,
      p.chave, p.order_ids, p.data_ml, p.status_ml, p.situacao, p.total, p.comissao, p.frete,
      p.codparc, p.nunotas_base, p.nota_json, p.analise_json, p.atualizado_em,
    );
  }

  listarPedidos(limite = 200) {
    return this.sql
      .exec(
        `SELECT chave, order_ids, data_ml, status_ml, situacao, total, comissao, frete, codparc,
                nunotas_base, atualizado_em, nunota, gravacao, gravacao_em, gravacao_erro, cancelamento, cancelamento_em
         FROM pedidos ORDER BY data_ml DESC LIMIT ?`,
        limite,
      )
      .toArray();
  }

  pedido(chave: string): (Pedido & Gravacao) | null {
    return this.sql.exec<Pedido & Gravacao>(`SELECT * FROM pedidos WHERE chave=?`, chave).toArray()[0] ?? null;
  }

  log(nivel: "info" | "aviso" | "erro", chave: string | null, msg: string): void {
    this.sql.exec(`INSERT INTO log (em, nivel, chave, msg) VALUES (?,?,?,?)`, Date.now(), nivel, chave, msg.slice(0, 2000));
    // Retenção: mantém os 20 mil registros mais recentes.
    this.sql.exec(`DELETE FROM log WHERE id <= (SELECT MAX(id) - 20000 FROM log)`);
  }

  listarLog(chave: string | null, limite = 200) {
    return chave
      ? this.sql.exec(`SELECT * FROM log WHERE chave=? ORDER BY id DESC LIMIT ?`, chave, limite).toArray()
      : this.sql.exec(`SELECT * FROM log ORDER BY id DESC LIMIT ?`, limite).toArray();
  }

  saude() {
    const ev = this.sql
      .exec<{ status: string; n: number }>(`SELECT status, COUNT(*) n FROM eventos GROUP BY status`)
      .toArray();
    const ped = this.sql
      .exec<{ situacao: string; n: number }>(`SELECT situacao, COUNT(*) n FROM pedidos GROUP BY situacao`)
      .toArray();
    const ultimo = this.sql.exec<{ m: number | null }>(`SELECT MAX(recebido_em) m FROM eventos`).one().m;
    return { eventos: ev, pedidos: ped, ultimoEventoEm: ultimo };
  }
}

export function storeStub(env: Env) {
  return env.STORE.get(env.STORE.idFromName("principal"));
}
