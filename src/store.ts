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
      CREATE TABLE IF NOT EXISTS anuncios (
        item_id TEXT PRIMARY KEY,
        sku TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        sub_status TEXT NOT NULL DEFAULT '',
        qtd_ml INTEGER NOT NULL DEFAULT 0,
        preco_ml REAL,
        listing_type TEXT NOT NULL DEFAULT '',
        lido_em INTEGER NOT NULL DEFAULT 0,
        ultima_acao TEXT,
        acao_em INTEGER
      );
      CREATE TABLE IF NOT EXISTS envios (
        shipment_id TEXT PRIMARY KEY,
        chave TEXT,
        status TEXT NOT NULL DEFAULT '',
        substatus TEXT NOT NULL DEFAULT '',
        logistica TEXT NOT NULL DEFAULT '',
        atualizado_em INTEGER NOT NULL,
        impresso_em INTEGER
      );
      CREATE TABLE IF NOT EXISTS fichas (
        pdp TEXT PRIMARY KEY,
        nome TEXT NOT NULL,
        grau TEXT NOT NULL DEFAULT '',
        cor TEXT NOT NULL DEFAULT '',
        capacidade TEXT NOT NULL DEFAULT '',
        marca TEXT NOT NULL DEFAULT '',
        modelo TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        parent_id TEXT,
        pdp_tradicional TEXT,
        chave TEXT NOT NULL,
        atualizado_em INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fichas_chave ON fichas(chave);
      CREATE TABLE IF NOT EXISTS casamentos (
        sku TEXT PRIMARY KEY,
        assinatura TEXT NOT NULL,
        versao_pool INTEGER NOT NULL,
        fichas TEXT NOT NULL DEFAULT '[]',
        motivo TEXT,
        em INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publicacoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT NOT NULL,
        pdp TEXT NOT NULL,
        tipo TEXT NOT NULL,
        preco REAL,
        qtd INTEGER,
        status TEXT NOT NULL,
        mlb TEXT,
        detalhe TEXT,
        quem TEXT NOT NULL,
        em INTEGER NOT NULL,
        auditado_em INTEGER
      );
      CREATE INDEX IF NOT EXISTS publicacoes_sku ON publicacoes(sku);
      CREATE TABLE IF NOT EXISTS funcoes (
        id TEXT PRIMARY KEY,
        nome TEXT NOT NULL,
        modulos TEXT NOT NULL DEFAULT '[]',
        admin INTEGER NOT NULL DEFAULT 0,
        criado_em INTEGER NOT NULL,
        atualizado_em INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usuarios (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        nome TEXT NOT NULL DEFAULT '',
        funcao TEXT NOT NULL,
        ativo INTEGER NOT NULL DEFAULT 1,
        criado_em INTEGER NOT NULL,
        atualizado_em INTEGER NOT NULL,
        ultimo_acesso INTEGER
      );
      CREATE TABLE IF NOT EXISTS meta (
        chave TEXT PRIMARY KEY,
        valor TEXT
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
    // Função de administrador sempre existe (acesso a tudo + telas de usuários e funções).
    const agora = Date.now();
    this.sql.exec(
      `INSERT OR IGNORE INTO funcoes (id, nome, modulos, admin, criado_em, atualizado_em) VALUES ('administrador', 'Administrador', '[]', 1, ?, ?)`,
      agora, agora,
    );
    // Expedição em 3 fases: marca quando o envio saiu da nossa mão (bipado na agência).
    const colsEnv = new Set(this.sql.exec<{ name: string }>(`PRAGMA table_info(envios)`).toArray().map((c) => c.name));
    if (!colsEnv.has("despachado_em")) this.sql.exec(`ALTER TABLE envios ADD COLUMN despachado_em INTEGER`);
    // Ficha de catálogo de cada anúncio nosso: trava de duplicata (mesma ficha + mesmo tipo).
    const colsAn = new Set(this.sql.exec<{ name: string }>(`PRAGMA table_info(anuncios)`).toArray().map((c) => c.name));
    if (!colsAn.has("catalog_product_id")) this.sql.exec(`ALTER TABLE anuncios ADD COLUMN catalog_product_id TEXT`);
    // Agendado pelo ML (pending/buffered): data em que a etiqueta é liberada (lead_time.buffering.date).
    if (!colsEnv.has("liberacao")) this.sql.exec(`ALTER TABLE envios ADD COLUMN liberacao TEXT`);
    const jaCorrigido = this.sql.exec<{ n: number }>(`SELECT COUNT(*) n FROM meta WHERE chave = 'despacho_v2'`).one().n;
    if (!jaCorrigido) {
      this.sql.exec(`UPDATE envios SET despachado_em = NULL`);
      this.sql.exec(`INSERT INTO meta (chave, valor) VALUES ('despacho_v2', ?)`, String(Date.now()));
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

  /** `despachado_em` vem do histórico do envio no ML (ver despachoDoEnvio em etiquetas.ts); o ML é a fonte. */
  salvarEnvio(e: {
    shipment_id: string; chave: string | null; status: string; substatus: string; logistica: string;
    despachado_em?: number | null; liberacao?: string | null;
  }): void {
    this.sql.exec(
      `INSERT INTO envios (shipment_id, chave, status, substatus, logistica, atualizado_em, despachado_em, liberacao) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(shipment_id) DO UPDATE SET chave = COALESCE(excluded.chave, envios.chave), status = excluded.status,
         substatus = excluded.substatus, logistica = excluded.logistica, atualizado_em = excluded.atualizado_em,
         despachado_em = excluded.despachado_em, liberacao = excluded.liberacao`,
      e.shipment_id, e.chave, e.status, e.substatus, e.logistica, Date.now(), e.despachado_em ?? null, e.liberacao ?? null,
    );
  }

  /** Envios agendados pelo ML (pending/buffered): etiqueta só sai na data de liberação. */
  listarAgendados() {
    return this.sql
      .exec(
        `SELECT e.shipment_id, COALESCE(n.chave, e.chave) chave, e.chave envio_order, p.data_ml, e.status, e.substatus, e.logistica,
                e.atualizado_em, e.liberacao, n.fiscal_key, n.nunota_nf, n.status nf_status, p.total, p.order_ids
         FROM envios e
         LEFT JOIN nfs n ON n.shipment_id = e.shipment_id
         LEFT JOIN pedidos p ON p.chave = COALESCE(n.chave, e.chave)
         WHERE e.status = 'pending' AND e.substatus = 'buffered'
         ORDER BY COALESCE(e.liberacao, '9999') ASC, e.atualizado_em DESC LIMIT 300`,
      )
      .toArray();
  }

  /** Envios despachados desde `desde` (fase 3 da Expedição: o dia de hoje), mais recentes primeiro. */
  listarDespachados(desde: number) {
    return this.sql
      .exec(
        `SELECT e.shipment_id, COALESCE(n.chave, e.chave) chave, e.chave envio_order, p.data_ml, e.status, e.substatus, e.logistica,
                e.atualizado_em, e.impresso_em, e.despachado_em, n.fiscal_key, n.nunota_nf, p.total, p.order_ids
         FROM envios e
         LEFT JOIN nfs n ON n.shipment_id = e.shipment_id
         LEFT JOIN pedidos p ON p.chave = COALESCE(n.chave, e.chave)
         WHERE e.despachado_em >= ?
         ORDER BY e.despachado_em DESC LIMIT 300`,
        desde,
      )
      .toArray();
  }

  /** Quantidade por fase da Expedição (números dos submenus). */
  contagemExpedicao(desdeDespacho: number): { agendados: number; imprimir: number; impressos: number; despachados: number } {
    const r = this.sql
      .exec<{ agendados: number; imprimir: number; impressos: number; despachados: number }>(
        `SELECT
           SUM(CASE WHEN status = 'pending' AND substatus = 'buffered' THEN 1 ELSE 0 END) agendados,
           SUM(CASE WHEN status = 'ready_to_ship' AND substatus = 'ready_to_print' THEN 1 ELSE 0 END) imprimir,
           SUM(CASE WHEN status = 'ready_to_ship' AND substatus = 'printed' THEN 1 ELSE 0 END) impressos,
           SUM(CASE WHEN despachado_em >= ? THEN 1 ELSE 0 END) despachados
         FROM envios`,
        desdeDespacho,
      )
      .one();
    return { agendados: r.agendados ?? 0, imprimir: r.imprimir ?? 0, impressos: r.impressos ?? 0, despachados: r.despachados ?? 0 };
  }

  /** Envios das NFs conhecidas ainda não despachados, os mais desatualizados primeiro. */
  enviosParaAtualizar(limite: number): string[] {
    const ids = this.sql
      .exec<{ id: string }>(
        `SELECT n.shipment_id id FROM nfs n LEFT JOIN envios e ON e.shipment_id = n.shipment_id
         WHERE n.shipment_id IS NOT NULL AND n.status IN ('enviado','ja_no_ml')
           AND (e.shipment_id IS NULL OR e.status IN ('ready_to_ship','pending','handling')
                OR (e.despachado_em IS NULL AND e.status IN ('shipped','delivered','not_delivered')))
         ORDER BY COALESCE(e.atualizado_em, 0) ASC LIMIT ?`,
        limite,
      )
      .toArray().map((r) => r.id);
    // Agendados (pending/buffered) não têm NF enviada ainda: entram pela tabela de envios.
    const agendados = this.sql
      .exec<{ id: string }>(
        `SELECT shipment_id id FROM envios WHERE status = 'pending' AND substatus = 'buffered' ORDER BY atualizado_em ASC LIMIT ?`,
        Math.max(1, Math.floor(limite / 3)), // não toma a rodada toda: o webhook já avisa a liberação
      )
      .toArray().map((r) => r.id);
    return [...new Set([...agendados, ...ids])].slice(0, limite);
  }

  /** Pedido (pack/order), chave da NF e situação da venda de cada envio (faixa da NF e trava de cancelado). */
  pedidosDosEnvios(ids: string[]): Array<{ shipment_id: string; chave: string | null; fiscal_key: string | null; situacao: string | null; status_ml: string | null; envio_status: string | null }> {
    if (!ids.length) return [];
    return this.sql
      .exec<{ shipment_id: string; chave: string | null; fiscal_key: string | null; situacao: string | null; status_ml: string | null; envio_status: string | null }>(
        `SELECT e.shipment_id, COALESCE(n.chave, e.chave) chave, n.fiscal_key, p.situacao, p.status_ml, e.status envio_status
         FROM envios e LEFT JOIN nfs n ON n.shipment_id = e.shipment_id
         LEFT JOIN pedidos p ON p.chave = COALESCE(n.chave, e.chave)
         WHERE e.shipment_id IN (${ids.map(() => "?").join(",")})`,
        ...ids,
      )
      .toArray();
  }

  /** Envios imprimíveis (ready_to_ship + ready_to_print/printed), com NF e pedido para exibir. */
  listarEtiquetas() {
    return this.sql
      .exec(
        `SELECT e.shipment_id, COALESCE(n.chave, e.chave) chave, e.chave envio_order, p.data_ml, e.status, e.substatus, e.logistica, e.atualizado_em, e.impresso_em,
                n.fiscal_key, n.nunota_nf, p.total, p.order_ids
         FROM envios e
         LEFT JOIN nfs n ON n.shipment_id = e.shipment_id
         LEFT JOIN pedidos p ON p.chave = COALESCE(n.chave, e.chave)
         WHERE e.status = 'ready_to_ship' AND e.substatus IN ('ready_to_print','printed')
         ORDER BY e.substatus DESC, e.atualizado_em DESC LIMIT 300`,
      )
      .toArray();
  }

  marcarImpressos(ids: string[]): void {
    for (const id of ids) this.sql.exec(`UPDATE envios SET impresso_em = ? WHERE shipment_id = ?`, Date.now(), id);
  }

  /** Pedidos com NF e envio, para a esteira do módulo Pedidos. */
  fluxo(desde: string, limite = 500) {
    return this.sql
      .exec(
        `SELECT p.chave, p.order_ids, p.data_ml, p.status_ml, p.situacao, p.total, p.comissao, p.frete, p.codparc,
                p.nunota, p.gravacao, p.gravacao_erro, p.cancelamento, p.nunotas_base, p.atualizado_em,
                n.nunota_nf, n.status nf_status, n.fiscal_key, n.detalhe nf_detalhe, n.shipment_id,
                e.status envio_status, e.substatus envio_substatus, e.impresso_em
         FROM pedidos p
         LEFT JOIN nfs n ON n.chave = p.chave
         LEFT JOIN envios e ON e.shipment_id = n.shipment_id
         WHERE p.data_ml >= ? ORDER BY p.data_ml DESC LIMIT ?`,
        desde, limite,
      )
      .toArray();
  }

  todosAnuncios() {
    return this.sql
      .exec(`SELECT item_id, sku, status, sub_status, qtd_ml, preco_ml, listing_type, lido_em, ultima_acao, acao_em
             FROM anuncios WHERE status <> 'fora' ORDER BY sku`)
      .toArray();
  }

  /** Contagens de hoje para o painel de integração (desde = epoch ms do início do dia). */
  metricasDesde(desde: number) {
    const um = (sql: string) => Number(this.sql.exec<{ n: number }>(sql, desde).one().n ?? 0);
    return {
      eventosRecebidos: um(`SELECT COUNT(*) n FROM eventos WHERE recebido_em >= ?`),
      pedidosGravados: um(`SELECT COUNT(*) n FROM pedidos WHERE gravacao = 'gravado' AND gravacao_em >= ?`),
      xmlEnviados: um(`SELECT COUNT(*) n FROM nfs WHERE status = 'enviado' AND atualizado_em >= ?`),
      ajustesAnuncio: um(`SELECT COUNT(*) n FROM anuncios WHERE acao_em >= ? AND ultima_acao LIKE 'ok%'`),
      falhasAnuncio: um(`SELECT COUNT(*) n FROM anuncios WHERE acao_em >= ? AND ultima_acao NOT LIKE 'ok%'`),
      errosLog: um(`SELECT COUNT(*) n FROM log WHERE nivel = 'erro' AND em >= ?`),
      etiquetasBaixadas: um(`SELECT COUNT(*) n FROM envios WHERE impresso_em >= ?`),
    };
  }

  ultimoLogDe(padrao: string): { em: number; nivel: string; msg: string } | null {
    return (this.sql
      .exec<{ em: number; nivel: string; msg: string }>(`SELECT em, nivel, msg FROM log WHERE msg LIKE ? ORDER BY id DESC LIMIT 1`, padrao)
      .toArray()[0]) ?? null;
  }

  // ------------------------------------------------------------------ funções e usuários

  listarFuncoes(): Array<{ id: string; nome: string; modulos: string[]; admin: boolean; usuarios: number }> {
    return this.sql
      .exec<{ id: string; nome: string; modulos: string; admin: number; usuarios: number }>(
        `SELECT f.id, f.nome, f.modulos, f.admin, (SELECT COUNT(*) FROM usuarios u WHERE u.funcao = f.id) usuarios
         FROM funcoes f ORDER BY f.admin DESC, f.nome`,
      )
      .toArray()
      .map((f) => ({ id: f.id, nome: f.nome, modulos: JSON.parse(f.modulos || "[]"), admin: f.admin === 1, usuarios: f.usuarios }));
  }

  funcao(id: string): { id: string; nome: string; modulos: string[]; admin: boolean } | null {
    return this.listarFuncoes().find((f) => f.id === id) ?? null;
  }

  salvarFuncao(f: { id: string; nome: string; modulos: string[]; admin: boolean }): void {
    const agora = Date.now();
    this.sql.exec(
      `INSERT INTO funcoes (id, nome, modulos, admin, criado_em, atualizado_em) VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET nome = excluded.nome, modulos = excluded.modulos, admin = excluded.admin, atualizado_em = excluded.atualizado_em`,
      f.id, f.nome, JSON.stringify(f.modulos), f.admin ? 1 : 0, agora, agora,
    );
  }

  removerFuncao(id: string): void {
    this.sql.exec(`DELETE FROM funcoes WHERE id = ? AND id <> 'administrador' AND NOT EXISTS (SELECT 1 FROM usuarios WHERE funcao = ?)`, id, id);
  }

  usuario(id: string): { id: string; email: string; nome: string; funcao: string; ativo: boolean } | null {
    const u = this.sql.exec<{ id: string; email: string; nome: string; funcao: string; ativo: number }>(
      `SELECT id, email, nome, funcao, ativo FROM usuarios WHERE id = ?`, id,
    ).toArray()[0];
    return u ? { ...u, ativo: u.ativo === 1 } : null;
  }

  listarUsuarios(): Array<{ id: string; email: string; nome: string; funcao: string; ativo: boolean; criado_em: number; ultimo_acesso: number | null }> {
    return this.sql
      .exec<{ id: string; email: string; nome: string; funcao: string; ativo: number; criado_em: number; ultimo_acesso: number | null }>(
        `SELECT id, email, nome, funcao, ativo, criado_em, ultimo_acesso FROM usuarios ORDER BY ativo DESC, nome, email`,
      )
      .toArray()
      .map((u) => ({ ...u, ativo: u.ativo === 1 }));
  }

  salvarUsuario(u: { id: string; email: string; nome: string; funcao: string; ativo: boolean }): void {
    const agora = Date.now();
    this.sql.exec(
      `INSERT INTO usuarios (id, email, nome, funcao, ativo, criado_em, atualizado_em) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, nome = excluded.nome, funcao = excluded.funcao,
         ativo = excluded.ativo, atualizado_em = excluded.atualizado_em`,
      u.id, u.email.toLowerCase(), u.nome, u.funcao, u.ativo ? 1 : 0, agora, agora,
    );
  }

  /** Registra o acesso (no máximo 1 gravação a cada 5 min por pessoa, para poupar escrita). */
  marcarAcesso(id: string): void {
    const agora = Date.now();
    this.sql.exec(`UPDATE usuarios SET ultimo_acesso = ? WHERE id = ? AND COALESCE(ultimo_acesso, 0) < ?`, agora, id, agora - 5 * 60_000);
  }

  adminsAtivos(): number {
    return this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) n FROM usuarios u JOIN funcoes f ON f.id = u.funcao WHERE u.ativo = 1 AND f.admin = 1`,
    ).one().n;
  }

  meta(chave: string): string | null {
    return this.sql.exec<{ valor: string }>(`SELECT valor FROM meta WHERE chave = ?`, chave).toArray()[0]?.valor ?? null;
  }

  setMeta(chave: string, valor: string): void {
    this.sql.exec(`INSERT INTO meta (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`, chave, valor);
  }

  /** Ids ativos/pausados da conta: insere os novos e marca como "fora" quem sumiu. */
  registrarIdsAnuncios(ids: string[]): void {
    const set = new Set(ids);
    for (const id of ids) this.sql.exec(`INSERT OR IGNORE INTO anuncios (item_id, lido_em) VALUES (?, 0)`, id);
    for (const r of this.sql.exec<{ item_id: string }>(`SELECT item_id FROM anuncios WHERE status <> 'fora'`).toArray()) {
      if (!set.has(r.item_id)) this.sql.exec(`UPDATE anuncios SET status = 'fora' WHERE item_id = ?`, r.item_id);
    }
  }

  idsParaReler(limite: number): string[] {
    return this.sql
      .exec<{ item_id: string }>(`SELECT item_id FROM anuncios WHERE status <> 'fora' ORDER BY lido_em ASC LIMIT ?`, limite)
      .toArray().map((r) => r.item_id);
  }

  salvarAnuncios(lista: Array<{ item_id: string; sku: string; status: string; sub_status: string; qtd_ml: number; preco_ml: number | null; listing_type: string; catalog_product_id?: string | null }>): void {
    const agora = Date.now();
    for (const a of lista) {
      this.sql.exec(
        `INSERT INTO anuncios (item_id, sku, status, sub_status, qtd_ml, preco_ml, listing_type, lido_em, catalog_product_id)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(item_id) DO UPDATE SET sku=excluded.sku, status=excluded.status, sub_status=excluded.sub_status,
           qtd_ml=excluded.qtd_ml, preco_ml=excluded.preco_ml, listing_type=excluded.listing_type, lido_em=excluded.lido_em,
           catalog_product_id=COALESCE(excluded.catalog_product_id, anuncios.catalog_product_id)`,
        a.item_id, a.sku, a.status, a.sub_status, a.qtd_ml, a.preco_ml, a.listing_type, agora, a.catalog_product_id ?? null,
      );
    }
  }

  // ------------------------------------------------------------------ publicação de anúncios

  /** Grava/atualiza fichas de catálogo (importação do pool ou expansão de família). */
  salvarFichas(lista: Array<{ pdp: string; nome: string; grau: string; cor: string; capacidade: string; marca: string; modelo: string; status: string; parent_id: string | null; pdp_tradicional: string | null; chave: string }>): number {
    const agora = Date.now();
    for (const f of lista) {
      this.sql.exec(
        `INSERT INTO fichas (pdp, nome, grau, cor, capacidade, marca, modelo, status, parent_id, pdp_tradicional, chave, atualizado_em)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(pdp) DO UPDATE SET nome=excluded.nome, grau=excluded.grau, cor=excluded.cor, capacidade=excluded.capacidade,
           marca=excluded.marca, modelo=excluded.modelo, status=excluded.status, parent_id=excluded.parent_id,
           pdp_tradicional=excluded.pdp_tradicional, chave=excluded.chave, atualizado_em=excluded.atualizado_em`,
        f.pdp, f.nome, f.grau, f.cor, f.capacidade, f.marca, f.modelo, f.status, f.parent_id, f.pdp_tradicional, f.chave, agora,
      );
    }
    // Pool mudou: casamentos antigos ficam desatualizados (a versão entra na comparação).
    if (lista.length) this.setMeta("versao_pool", String(Number(this.meta("versao_pool") ?? "0") + 1));
    return lista.length;
  }

  fichasDaChave(chaves: string[]) {
    if (!chaves.length) return [];
    return this.sql
      .exec<{ pdp: string; nome: string; grau: string; cor: string; capacidade: string; marca: string; status: string }>(
        `SELECT pdp, nome, grau, cor, capacidade, marca, status FROM fichas WHERE chave IN (${chaves.map(() => "?").join(",")})`,
        ...chaves,
      )
      .toArray();
  }

  fichasPorPdp(pdps: string[]) {
    if (!pdps.length) return [];
    return this.sql
      .exec(`SELECT pdp, nome, grau, cor, capacidade, marca, modelo, status, parent_id, pdp_tradicional FROM fichas WHERE pdp IN (${pdps.map(() => "?").join(",")})`, ...pdps)
      .toArray();
  }

  contagemFichas(): number {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) n FROM fichas`).one().n;
  }

  casamentos(): Array<{ sku: string; assinatura: string; versao_pool: number; fichas: string; motivo: string | null; em: number }> {
    return this.sql.exec<{ sku: string; assinatura: string; versao_pool: number; fichas: string; motivo: string | null; em: number }>(
      `SELECT sku, assinatura, versao_pool, fichas, motivo, em FROM casamentos`,
    ).toArray();
  }

  salvarCasamentos(lista: Array<{ sku: string; assinatura: string; versao_pool: number; fichas: string; motivo: string | null }>): void {
    const agora = Date.now();
    for (const c of lista) {
      this.sql.exec(
        `INSERT INTO casamentos (sku, assinatura, versao_pool, fichas, motivo, em) VALUES (?,?,?,?,?,?)
         ON CONFLICT(sku) DO UPDATE SET assinatura=excluded.assinatura, versao_pool=excluded.versao_pool,
           fichas=excluded.fichas, motivo=excluded.motivo, em=excluded.em`,
        c.sku, c.assinatura, c.versao_pool, c.fichas, c.motivo, agora,
      );
    }
  }

  /** Anúncios nossos (não encerrados) por ficha e tipo — para a trava de duplicata. */
  fichasOcupadas(): Array<{ catalog_product_id: string; listing_type: string; item_id: string; sku: string }> {
    return this.sql.exec<{ catalog_product_id: string; listing_type: string; item_id: string; sku: string }>(
      `SELECT catalog_product_id, listing_type, item_id, sku FROM anuncios
       WHERE catalog_product_id IS NOT NULL AND status NOT IN ('closed', 'fora')`,
    ).toArray();
  }

  registrarPublicacao(p: { sku: string; pdp: string; tipo: string; preco: number | null; qtd: number | null; status: string; mlb: string | null; detalhe: string | null; quem: string }): number {
    this.sql.exec(
      `INSERT INTO publicacoes (sku, pdp, tipo, preco, qtd, status, mlb, detalhe, quem, em) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      p.sku, p.pdp, p.tipo, p.preco, p.qtd, p.status, p.mlb, p.detalhe, p.quem, Date.now(),
    );
    return this.sql.exec<{ id: number }>(`SELECT last_insert_rowid() id`).one().id;
  }

  marcarAuditoria(id: number, status: string, detalhe: string): void {
    this.sql.exec(`UPDATE publicacoes SET status = ?, detalhe = ?, auditado_em = ? WHERE id = ?`, status, detalhe, Date.now(), id);
  }

  listarPublicacoes(limite = 200) {
    return this.sql.exec(`SELECT id, sku, pdp, tipo, preco, qtd, status, mlb, detalhe, quem, em, auditado_em FROM publicacoes ORDER BY id DESC LIMIT ?`, limite).toArray();
  }

  publicacoesParaAuditar(maisVelhasQue: number) {
    return this.sql.exec<{ id: number; sku: string; pdp: string; tipo: string; preco: number | null; mlb: string }>(
      `SELECT id, sku, pdp, tipo, preco, mlb FROM publicacoes WHERE status = 'criado' AND em < ? ORDER BY id LIMIT 10`, maisVelhasQue,
    ).toArray();
  }

  anunciosAtivos() {
    return this.sql
      .exec(`SELECT item_id, sku, status, sub_status, qtd_ml, preco_ml, listing_type FROM anuncios
             WHERE status IN ('active','paused') AND lido_em > 0`)
      .toArray();
  }

  registrarAcaoAnuncio(item_id: string, texto: string, qtd: number | null, preco: number | null): void {
    this.sql.exec(
      `UPDATE anuncios SET ultima_acao = ?, acao_em = ?, qtd_ml = COALESCE(?, qtd_ml), preco_ml = COALESCE(?, preco_ml) WHERE item_id = ?`,
      texto.slice(0, 500), Date.now(), qtd, preco, item_id,
    );
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

  /** Só evento com erro volta para a fila (auditoria F7). true = reaberto. */
  reabrirEvento(id: number): boolean {
    const r = this.sql.exec(`UPDATE eventos SET status='pendente', tentativas=0, proximo_em=?, erro=NULL WHERE id=? AND status='erro'`, Date.now(), id);
    return r.rowsWritten > 0;
  }

  /** Notificações registradas no último intervalo (freio de processamento imediato no webhook). */
  eventosRecentes(ms: number): number {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) n FROM eventos WHERE recebido_em >= ?`, Date.now() - ms).one().n;
  }

  /** Retenção (auditoria F1): eventos concluídos com mais de 30 dias saem. */
  limparEventosAntigos(): number {
    const r = this.sql.exec(`DELETE FROM eventos WHERE status IN ('ok','ignorado') AND recebido_em < ?`, Date.now() - 30 * 86_400_000);
    return r.rowsWritten;
  }

  /**
   * Contador diário (8 dias) no meta, no lugar de logar o corpo da notificação:
   * "descartes" (conta/app errados) e "webhook" (por rota: segredo × legado).
   */
  contar(grupo: "descartes" | "webhook", motivo: string): void {
    const dia = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
    const atual = JSON.parse(this.meta(grupo) ?? "{}") as Record<string, Record<string, number>>;
    for (const d of Object.keys(atual)) if (d < new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10)) delete atual[d];
    atual[dia] = { ...(atual[dia] ?? {}), [motivo]: (atual[dia]?.[motivo] ?? 0) + 1 };
    this.setMeta(grupo, JSON.stringify(atual));
  }

  contadores(grupo: "descartes" | "webhook"): Record<string, Record<string, number>> {
    return JSON.parse(this.meta(grupo) ?? "{}");
  }

  /** Confirmação manual só vale para pedido que o SkyHub gravou (auditoria F4). */
  pedidoGravadoComNunota(nunota: number): boolean {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) n FROM pedidos WHERE nunota = ? AND gravacao = 'gravado'`, nunota).one().n > 0;
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
