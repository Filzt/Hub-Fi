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
  situacao: string; // sombra_ok | divergente | sem_base | bloqueado | cancelado | erro
  total: number;
  comissao: number;
  frete: number;
  codparc: number | null;
  nunotas_base: string | null;
  nota_json: string | null;
  analise_json: string;
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
      CREATE TABLE IF NOT EXISTS log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        em INTEGER NOT NULL,
        nivel TEXT NOT NULL,
        chave TEXT,
        msg TEXT NOT NULL
      );
    `);
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

  salvarPedido(p: Pedido): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO pedidos
       (chave, order_ids, data_ml, status_ml, situacao, total, comissao, frete, codparc,
        nunotas_base, nota_json, analise_json, atualizado_em)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      p.chave, p.order_ids, p.data_ml, p.status_ml, p.situacao, p.total, p.comissao, p.frete,
      p.codparc, p.nunotas_base, p.nota_json, p.analise_json, p.atualizado_em,
    );
  }

  listarPedidos(limite = 200): Omit<Pedido, "nota_json" | "analise_json">[] {
    return this.sql
      .exec<Pedido>(
        `SELECT chave, order_ids, data_ml, status_ml, situacao, total, comissao, frete, codparc,
                nunotas_base, atualizado_em
         FROM pedidos ORDER BY data_ml DESC LIMIT ?`,
        limite,
      )
      .toArray();
  }

  pedido(chave: string): Pedido | null {
    return this.sql.exec<Pedido>(`SELECT * FROM pedidos WHERE chave=?`, chave).toArray()[0] ?? null;
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
