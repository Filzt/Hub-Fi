// skyhub — entrada do Worker: webhook do ML, API do painel e cron de reprocessamento.

import { rotaAdmin } from "./admin.ts";
import { emailValido, moduloDaRota, MODULOS as MODULOS_TODOS, pode, type Modulo, type Quem, senhaRecente, supabaseAdmin, verificarJwt } from "./auth.ts";
import { CANAIS, montarCatalogo } from "./catalogo.ts";
import { alterarFlex, configFlex } from "./flex.ts";
import { checarBipe } from "./expedicao.ts";
import { adicionarFamilia, atualizarCandidatos, auditarPublicacoes, casarPendentes, conferir, fila as filaPublicacao,
  importarFichas, processarFilaFichas, publicar } from "./publicacao.ts";
import { TOPICOS_ACEITOS } from "./config.ts";
import { tokenStub } from "./meli.ts";
import { cancelarNoErp, confirmarPedidoErp, gravarPedido, processarEvento, processarPedido } from "./processamento.ts";
import { erpDaUltimaRodada, reguasVigentes, sincronizarEstoque } from "./estoque.ts";
import { FASES, fase, type LinhaFluxo } from "./fluxo.ts";
import { REGUA_PRECO, LIMITES_REGUA, simularReguas, validarReguas, type AnuncioSync } from "./sync.ts";
import { atualizarEnviosPendentes, baixarEtiquetas } from "./etiquetas.ts";
import { processarNf, varrerNfs } from "./nf.ts";
import { storeStub } from "./store.ts";
import { type Env, ErroDefinitivo, ErroTemporario } from "./tipos.ts";

export { MeliToken } from "./meli.ts";
export { Store } from "./store.ts";
import { atenderSaida, origemDaSaida, origemLocal, ROTA_SAIDA } from "./saida.ts";

const json = (dados: unknown, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    },
  });

/** Comparação em tempo constante de dois segredos (hash dos dois lados). */
async function mesmoSegredo(recebido: string, esperado: string | undefined): Promise<boolean> {
  if (!esperado || !recebido) return false;
  const h = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([h(recebido), h(esperado)]);
  return crypto.subtle.timingSafeEqual(a, b);
}
/** Segredo configurado com menos de 32 caracteres não vale (auditoria F3): recusa em vez de aceitar fraco. */
const forte = (s: string | undefined) => !!s && s.length >= 32;

/** ADMIN_TOKEN (scripts de operação). Não vale se for fraco. */
async function ehTokenDoSistema(recebido: string, env: Env): Promise<boolean> {
  return forte(env.ADMIN_TOKEN) && (await mesmoSegredo(recebido, env.ADMIN_TOKEN));
}

/**
 * Quem está chamando a API: o ADMIN_TOKEN (scripts) ou uma pessoa logada pelo Supabase
 * e cadastrada no SkyHub. `motivo` explica a recusa (401 sem login, 403 sem acesso).
 */
async function identificar(req: Request, env: Env): Promise<{ quem: Quem } | { motivo: string; status: number }> {
  const recebido = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!recebido) return { motivo: "faça login", status: 401 };
  // Token dos scripts: só serve para pegar o token do ML (auditoria F2) — e nada mais.
  if (forte(env.SCRIPTS_TOKEN) && (await mesmoSegredo(recebido, env.SCRIPTS_TOKEN))) {
    return { quem: { tipo: "scripts", id: "scripts", email: "scripts", nome: "Scripts", funcao: null, admin: false, modulos: [] } };
  }
  if (await ehTokenDoSistema(recebido, env)) {
    return { quem: { tipo: "sistema", id: "sistema", email: "sistema", nome: "Sistema", funcao: null, admin: true, modulos: [] } };
  }
  const claims = await verificarJwt(env, recebido);
  if (!claims) return { motivo: "sessão expirada ou inválida — faça login de novo", status: 401 };
  const store = storeStub(env);
  let u = await store.usuario(claims.sub);
  // 1º acesso do administrador inicial (ADMIN_INICIAL): entra já como Administrador.
  const email = String(claims.email ?? "").toLowerCase();
  if (!u && email && email === String(env.ADMIN_INICIAL ?? "").toLowerCase()) {
    await store.salvarUsuario({ id: claims.sub, email, nome: email.split("@")[0], funcao: "administrador", ativo: true });
    await store.log("info", null, `administrador inicial registrado: ${email}`);
    u = await store.usuario(claims.sub);
  }
  if (!u) return { motivo: "seu e-mail ainda não tem acesso ao SkyHub — peça a um administrador", status: 403 };
  if (!u.ativo) return { motivo: "seu acesso ao SkyHub está desativado", status: 403 };
  const f = await store.funcao(u.funcao);
  await store.marcarAcesso(u.id);
  return {
    quem: { tipo: "usuario", id: u.id, email: u.email, nome: u.nome, funcao: f?.nome ?? u.funcao, admin: !!f?.admin, modulos: (f?.modulos ?? []) as Modulo[] },
  };
}

// Acima disso por minuto, o webhook só registra e o cron processa (auditoria F1: um flood
// forjado não vira uma análise completa por notificação).
const WEBHOOK_PROCESSA_POR_MINUTO = 30;

async function webhook(req: Request, env: Env, ctx: ExecutionContext, via: "segredo" | "legado"): Promise<Response> {
  // O ML exige 200 em até 500 ms, senão desativa o tópico: registra e processa depois.
  // Nunca confia no payload — ele só diz QUAL recurso reler na API.
  let n: { topic?: string; resource?: string; user_id?: number | string; application_id?: number | string };
  try {
    n = await req.json();
  } catch {
    return json({ ok: false, motivo: "json inválido" }, 400);
  }
  const store = storeStub(env);
  const formato = n.topic ? TOPICOS_ACEITOS.get(n.topic) : undefined;
  const daConta = String(n.user_id ?? "") === env.MELI_USER_ID;
  const doApp = n.application_id != null && String(n.application_id) === env.MELI_CLIENT_ID; // obrigatório
  if (!formato || !n.resource || !formato.test(n.resource) || !daConta || !doApp) {
    // Tópico que não usamos (items, price_suggestion…) cai aqui em silêncio; o corpo não vai
    // para o log (ele empurrava o log legítimo para fora). Conta/app errados ficam só contados.
    if (!daConta || !doApp) ctx.waitUntil(store.contar("descartes", !daConta ? "outra_conta" : "outro_app"));
    return json({ ok: true, ignorado: true }); // 200 para o ML não reenviar lixo
  }
  const id = await store.registrarEvento(n.topic!, n.resource);
  ctx.waitUntil(store.contar("webhook", via)); // mostra quando o ML passou a usar a URL com segredo
  if ((await store.eventosRecentes(60_000)) > WEBHOOK_PROCESSA_POR_MINUTO) return json({ ok: true, adiado: true });
  ctx.waitUntil(
    (async () => {
      const ev = await store.evento(id);
      if (ev && ev.status === "pendente") await processarEvento(env, ev);
    })(),
  );
  return json({ ok: true });
}

async function rotaApi(req: Request, env: Env, url: URL): Promise<Response> {
  const id = await identificar(req, env);
  if ("motivo" in id) return json({ erro: id.motivo }, id.status);
  const { quem } = id;
  const store = storeStub(env);
  const p = url.pathname;
  const m = (re: RegExp) => p.match(re);
  if (!pode(quem, moduloDaRota(req.method, p))) return json({ erro: "sua função não tem acesso a esta tela" }, 403);
  // Rastro de quem fez cada ação (a leitura não entra, para não encher o log).
  if (req.method !== "GET" && quem.tipo === "usuario") await store.log("info", null, `${req.method} ${p} por ${quem.email}`);

  if (req.method === "GET" && p === "/api/admin/config") {
    const nomes = ["MELI_CLIENT_ID", "MELI_CLIENT_SECRET", "SANKHYA_CLIENT_ID", "SANKHYA_CLIENT_SECRET", "SANKHYA_XTOKEN",
      "ADMIN_TOKEN", "SUPABASE_SECRET_KEY", "WEBHOOK_SECRET", "SCRIPTS_TOKEN"] as const;
    return json({
      modo: env.MODO, webhookLegado: env.WEBHOOK_LEGADO,
      secrets: Object.fromEntries(nomes.map((n) => [n, Boolean(env[n])])),
      fortes: Object.fromEntries((["ADMIN_TOKEN", "WEBHOOK_SECRET", "SCRIPTS_TOKEN"] as const).map((n) => [n, forte(env[n])])),
      descartes: await store.contadores("descartes"),
      webhookPorRota: await store.contadores("webhook"),
    });
  }
  if (req.method === "GET" && p === "/api/eu") {
    return json({ id: quem.id, email: quem.email, nome: quem.nome, funcao: quem.funcao, admin: quem.admin, modulos: quem.admin ? MODULOS_TODOS : quem.modulos });
  }
  // Meu perfil: a própria pessoa muda nome e e-mail (função e acesso continuam com o administrador).
  if (req.method === "PUT" && p === "/api/eu") {
    if (quem.tipo !== "usuario") return json({ erro: "só para usuários do painel" }, 403);
    const b = (await req.json().catch(() => ({}))) as { nome?: unknown; email?: unknown };
    const atual = await store.usuario(quem.id);
    if (!atual) return json({ erro: "usuário não encontrado" }, 404);
    const nome = b.nome === undefined ? atual.nome : String(b.nome).replace(/\s+/g, " ").trim().slice(0, 80);
    if (nome.length < 2) return json({ erro: "Informe o nome." }, 400);
    const email = b.email === undefined ? atual.email : String(b.email).trim().toLowerCase();
    if (email !== atual.email) {
      if (!emailValido(email)) return json({ erro: "E-mail inválido." }, 400);
      if ((await store.listarUsuarios()).some((u) => u.id !== quem.id && u.email === email)) return json({ erro: "Esse e-mail já é de outro usuário." }, 409);
      // Senha digitada nos últimos 5 min (o painel pede e o Supabase confere; a senha não passa por aqui).
      const claims = await verificarJwt(env, (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim());
      if (!claims || claims.sub !== quem.id || !senhaRecente(claims, Math.floor(Date.now() / 1000))) {
        return json({ erro: "Confirme sua senha atual para trocar o e-mail." }, 403);
      }
      try { await supabaseAdmin(env, "PUT", `/admin/users/${quem.id}`, { email, email_confirm: true }); }
      catch (e) { return json({ erro: "O login não aceitou o e-mail novo: " + (e as Error).message.slice(0, 160) }, 400); }
    }
    await store.salvarUsuario({ ...atual, nome, email });
    const mudou = [nome !== atual.nome ? "nome" : "", email !== atual.email ? `e-mail (${atual.email} → ${email})` : ""].filter(Boolean);
    if (mudou.length) await store.log("info", null, `perfil alterado por ${atual.email}: ${mudou.join(", ")}`);
    return json({ nome, email, emailMudou: email !== atual.email });
  }
  if (p.startsWith("/api/admin/")) {
    const res = await rotaAdmin(req, env, url, quem, store);
    if (res) return res;
  }

  if (req.method === "GET" && p === "/api/saude") {
    return json({ modo: env.MODO, meli: await tokenStub(env).status(), store: await store.saude() });
  }
  if (req.method === "GET" && p === "/api/pedidos") return json({ pedidos: await store.listarPedidos() });

  let r = m(/^\/api\/pedidos\/(\d+)$/);
  if (req.method === "GET" && r) {
    const pedido = await store.pedido(r[1]);
    return pedido ? json({ pedido }) : json({ erro: "pedido não encontrado" }, 404);
  }
  r = m(/^\/api\/pedidos\/(\d+)\/processar$/);
  if (req.method === "POST" && r) {
    try {
      return json({ pedido: await processarPedido(env, r[1]) });
    } catch (e) {
      await store.log("erro", r[1], `processamento manual: ${(e as Error).message}`);
      return json({ erro: (e as Error).message }, 502);
    }
  }
  r = m(/^\/api\/pedidos\/(\d+)\/gravar$/);
  if (req.method === "POST" && r) {
    // Grava parceiro (se novo) e pedido 1090 no Sankhya. Só em MODO manual/automatico.
    try {
      return json({ pedido: await gravarPedido(env, r[1]) });
    } catch (e) {
      return json({ erro: (e as Error).message }, 409);
    }
  }
  r = m(/^\/api\/notas\/(\d+)\/confirmar$/);
  if (req.method === "POST" && r && !(await store.pedidoGravadoComNunota(Number(r[1])))) {
    return json({ erro: `NUNOTA ${r[1]} não foi gravado pelo SkyHub — confirme pelo Sankhya` }, 404);
  }
  if (req.method === "POST" && r) {
    const res = await confirmarPedidoErp(env, Number(r[1]));
    await store.log(res.ok ? "info" : "aviso", null, `confirmar NUNOTA ${r[1]}: ${res.ok ? "ok (L)" : res.motivo}`);
    return json(res, res.ok ? 200 : 409);
  }
  r = m(/^\/api\/pedidos\/(\d+)\/cancelar-erp$/);
  if (req.method === "POST" && r) {
    try {
      const res = await cancelarNoErp(env, r[1]);
      return json(res, res.acao === "cancelado" || res.acao === "nada" ? 200 : 409);
    } catch (e) {
      return json({ erro: (e as Error).message }, 409);
    }
  }
  // Módulo Pedidos: esteira por fase ---------------------------------------------
  if (req.method === "GET" && p === "/api/fluxo") {
    const dias = Math.min(60, Math.max(1, Number(url.searchParams.get("dias") ?? 7)));
    const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
    const linhas = (await store.fluxo(desde)).map((l) => ({ ...l, fase: fase(l as unknown as LinhaFluxo) }));
    const contagem = Object.fromEntries(FASES.map((f) => [f, linhas.filter((l) => l.fase === f).length]));
    return json({ dias, fases: FASES, contagem, pedidos: linhas });
  }

  // Módulo Produtos ---------------------------------------------------------------
  if (req.method === "GET" && p === "/api/produtos") {
    // Uma linha por SKU, com a situação em cada canal (catalogo.ts).
    const [anuncios, erp, reguas, erpEm, pubErp] = await Promise.all([
      store.todosAnuncios(), erpDaUltimaRodada(env), reguasVigentes(env), store.meta("ultimo_erp_em"), store.meta("pub_erp"),
    ]);
    const semAnuncio = pubErp ? (JSON.parse(pubErp) as { skus: Array<{ sku: string; produto: string; disp: number; preco_loja: number | null }> }).skus : [];
    const produtos = montarCatalogo(anuncios as never, erp, semAnuncio, reguas);
    return json({ erpEm: erpEm ? Number(erpEm) : null, canais: CANAIS, produtos });
  }

  // Envio Flex (menu Mercado Livre) ---------------------------------------------------
  if (req.method === "GET" && p === "/api/flex") {
    const [config, anuncios, novos] = await Promise.all([configFlex(env), store.todosAnuncios(), store.meta("flex_novos")]);
    const erp = await erpDaUltimaRodada(env);
    const lista = (anuncios as Array<Record<string, unknown>>)
      .filter((a) => a.status === "active" || a.status === "paused")
      .map((a) => ({ ...a, produto: erp.get(String(a.sku))?.produto ?? null, disp: erp.get(String(a.sku))?.disp ?? null }));
    return json({ config, novosComFlex: novos === "1", anuncios: lista });
  }
  if (req.method === "POST" && p === "/api/flex") {
    const b = (await req.json().catch(() => ({}))) as { ids?: unknown; ativar?: unknown };
    if (typeof b.ativar !== "boolean") return json({ erro: "informe ativar: true ou false" }, 400);
    try { return json({ resultados: await alterarFlex(env, b.ids, b.ativar, quem.email) }); }
    catch (e) { if (e instanceof ErroDefinitivo) return json({ erro: e.message }, 400); throw e; }
  }
  if (req.method === "POST" && p === "/api/flex/novos") {
    const b = (await req.json().catch(() => ({}))) as { ativo?: unknown };
    if (typeof b.ativo !== "boolean") return json({ erro: "informe ativo: true ou false" }, 400);
    await store.setMeta("flex_novos", b.ativo ? "1" : "0");
    await store.log("info", null, `novos anúncios ${b.ativo ? "com" : "sem"} Flex por padrão — ${quem.email}`);
    return json({ novosComFlex: b.ativo });
  }

  // Módulo Precificação -----------------------------------------------------------
  if (req.method === "GET" && p === "/api/reguas") {
    const salvo = await store.meta("reguas");
    const hist = await store.meta("reguas_hist");
    return json({
      reguas: await reguasVigentes(env), padrao: REGUA_PRECO, limites: LIMITES_REGUA,
      vigente: salvo ? JSON.parse(salvo) : null, historico: hist ? JSON.parse(hist) : [],
    });
  }
  if (req.method === "POST" && p === "/api/reguas/simular") {
    const corpo = (await req.json().catch(() => ({}))) as { reguas?: unknown };
    const v = validarReguas(corpo.reguas);
    if (!v.ok) return json({ erro: v.erro }, 400);
    const anuncios = (await store.anunciosAtivos()) as unknown as AnuncioSync[];
    return json(simularReguas(anuncios, await erpDaUltimaRodada(env), v.reguas));
  }
  if (req.method === "POST" && p === "/api/reguas") {
    const corpo = (await req.json().catch(() => ({}))) as { reguas?: unknown; responsavel?: string; motivo?: string };
    const v = validarReguas(corpo.reguas);
    if (!v.ok) return json({ erro: v.erro }, 400);
    // Responsável vem do login, não do corpo (auditoria F2: o texto livre podia ser forjado).
    const responsavel = quem.tipo === "usuario" ? quem.email : String(corpo.responsavel ?? "sistema").trim().slice(0, 60) || "sistema";
    const motivo = String(corpo.motivo ?? "").trim().slice(0, 200);
    if (!responsavel) return json({ erro: "informe quem está alterando" }, 400);
    const anterior = await reguasVigentes(env);
    const registro = { reguas: v.reguas, anterior, responsavel, motivo, em: Date.now() };
    await store.setMeta("reguas", JSON.stringify(registro));
    const hist = JSON.parse((await store.meta("reguas_hist")) ?? "[]") as unknown[];
    await store.setMeta("reguas_hist", JSON.stringify([registro, ...hist].slice(0, 50)));
    await store.log("aviso", null, `régua de preço alterada por ${responsavel}: ${JSON.stringify(anterior)} → ${JSON.stringify(v.reguas)}${motivo ? ` — ${motivo}` : ""}`);
    return json({ ok: true, ...registro });
  }

  // Módulo Integração: saúde e volume de hoje -------------------------------------
  if (req.method === "GET" && p === "/api/integracao/origem") {
    // Diagnóstico da saída fixa para o Sankhya (saida.ts): de onde esta execução e a saída falam.
    return json({ execucao: await origemLocal(), saidaSankhya: await origemDaSaida(env).catch((e) => `erro: ${(e as Error).message}`) });
  }
  if (req.method === "GET" && p === "/api/integracao") {
    const agora = Date.now();
    const inicioDia = agora - ((agora - 3 * 3_600_000) % 86_400_000); // meia-noite em São Paulo (UTC−3)
    const [meli, saude, metricas, plano, erpEm, ultErroSankhya, ultErroMl] = await Promise.all([
      tokenStub(env).status(), store.saude(), store.metricasDesde(inicioDia), store.meta("ultimo_plano"),
      store.meta("ultimo_erp_em"), store.ultimoLogDe("%Sankhya%"), store.ultimoLogDe("%ML %HTTP%"),
    ]);
    const resumo = plano ? (JSON.parse(plano) as { resumo: { em: number; abortado: string | null } }).resumo : null;
    const eventos = Object.fromEntries((saude.eventos as Array<{ status: string; n: number }>).map((e) => [e.status, e.n]));
    return json({
      agora,
      modos: { pedidos: env.MODO, xml: env.XML_MODO, cancelamento: env.CANCELAMENTO_MODO, estoque: env.ESTOQUE_MODO, preco: env.PRECO_MODO },
      ml: { tokenOk: meli.semeado && (meli.expiraEm ?? 0) > agora, expiraEm: meli.expiraEm ?? null, ultimoEvento: saude.ultimoEventoEm, eventosComErro: eventos.erro ?? 0, ultimoErro: ultErroMl },
      skyhub: { ultimaRodada: resumo?.em ?? null, rodadaAbortada: resumo?.abortado ?? null, eventosPendentes: eventos.pendente ?? 0 },
      sankhya: { ultimaLeitura: erpEm ? Number(erpEm) : null, ultimoErro: ultErroSankhya },
      hoje: metricas,
    });
  }

  // Etiquetas ---------------------------------------------------------------------
  if (req.method === "GET" && p === "/api/etiquetas") {
    if (url.searchParams.get("fase") === "despachados") return json({ etiquetas: await store.listarDespachados(inicioDoDiaSp()) });
    if (url.searchParams.get("fase") === "agendados") return json({ etiquetas: await store.listarAgendados() });
    return json({ etiquetas: await store.listarEtiquetas() });
  }
  if (req.method === "GET" && p === "/api/expedicao/contagem") return json(await store.contagemExpedicao(inicioDoDiaSp()));
  // Publicação de anúncios pelo SKU ----------------------------------------------
  if (req.method === "GET" && p === "/api/publicacao/fila") return json(await filaPublicacao(env));
  if (req.method === "POST" && p === "/api/publicacao/atualizar") {
    const n = await atualizarCandidatos(env);
    const casados = await casarPendentes(env, 60);
    return json({ candidatos: n, casados });
  }
  r = m(/^\/api\/publicacao\/sku\/([A-Za-z0-9._-]{1,40})$/);
  if (req.method === "GET" && r) return json(await conferir(env, r[1].toUpperCase()));
  if (req.method === "POST" && p === "/api/publicacao/publicar") {
    try {
      return json(await publicar(env, quem, (await req.json().catch(() => ({}))) as Record<string, unknown>));
    } catch (e) {
      return json({ erro: (e as Error).message }, e instanceof ErroTemporario ? 503 : 409);
    }
  }
  if (req.method === "POST" && p === "/api/publicacao/familia") {
    const b = (await req.json().catch(() => ({}))) as { link?: string };
    try { return json(await adicionarFamilia(env, String(b.link ?? ""))); } catch (e) { return json({ erro: (e as Error).message }, 400); }
  }
  if (req.method === "POST" && p === "/api/publicacao/fichas/importar") {
    const b = (await req.json().catch(() => ({}))) as { linhas?: Array<Record<string, unknown>> };
    return json({ gravadas: await importarFichas(env, b.linhas ?? []) });
  }

  // Expedição: cada bipe confere no ML, ao vivo, se a venda foi cancelada.
  if (req.method === "GET" && p === "/api/expedicao/checar") {
    return json(await checarBipe(env, String(url.searchParams.get("codigo") ?? "").slice(0, 200)));
  }
  if (req.method === "POST" && p === "/api/etiquetas/atualizar") {
    try {
      return json({ atualizados: await atualizarEnviosPendentes(env, 20) });
    } catch (e) {
      return json({ erro: (e as Error).message }, 502);
    }
  }
  if (req.method === "GET" && p === "/api/etiquetas/baixar") {
    const formato = url.searchParams.get("formato") === "zpl2" ? "zpl2" : "pdf";
    try {
      return await baixarEtiquetas(env, (url.searchParams.get("ids") ?? "").split(","), formato);
    } catch (e) {
      return json({ erro: (e as Error).message }, 409);
    }
  }
  // Estoque e preço --------------------------------------------------------------
  if (req.method === "GET" && p === "/api/estoque") {
    const plano = await store.meta("ultimo_plano");
    return json({ modos: { estoque: env.ESTOQUE_MODO, preco: env.PRECO_MODO }, plano: plano ? JSON.parse(plano) : null });
  }
  if (req.method === "POST" && p === "/api/estoque/rodar") {
    try {
      return json(await sincronizarEstoque(env, { forcarCatalogo: url.searchParams.get("catalogo") === "1" }));
    } catch (e) {
      return json({ erro: (e as Error).message }, 502);
    }
  }
  // NF-e → ML --------------------------------------------------------------------
  if (req.method === "GET" && p === "/api/nfs") return json({ xmlModo: env.XML_MODO, nfs: await store.listarNfs() });
  if (req.method === "POST" && p === "/api/nfs/varrer") {
    // Atualiza a situação sem enviar (enviar só com XML_MODO automatico ou botão por NF).
    return json(await varrerNfs(env, false, 3, 6));
  }
  r = m(/^\/api\/nfs\/(\d+)\/enviar$/);
  if (req.method === "POST" && r) {
    const nf = await store.nf(r[1]);
    if (!nf) return json({ erro: "NF não encontrada — rode a varredura antes" }, 404);
    try {
      return json({ status: await processarNf(env, r[1], nf.nunota_nf, true), nf: await store.nf(r[1]) });
    } catch (e) {
      return json({ erro: (e as Error).message }, 409);
    }
  }
  if (req.method === "GET" && p === "/api/eventos") {
    return json({ eventos: await store.listarEventos(url.searchParams.get("status")) });
  }
  r = m(/^\/api\/eventos\/(\d+)\/reabrir$/);
  if (req.method === "POST" && r) {
    if (!(await store.reabrirEvento(Number(r[1])))) return json({ erro: "só dá para reabrir evento com erro" }, 409);
    return json({ ok: true });
  }
  if (req.method === "GET" && p === "/api/log") {
    return json({ log: await store.listarLog(url.searchParams.get("chave")) });
  }

  // Token do ML ------------------------------------------------------------------
  if (req.method === "GET" && p === "/api/meli/status") return json(await tokenStub(env).status());
  if (req.method === "POST" && p === "/api/meli/semear") {
    // ATENÇÃO: consome o refresh_token informado. Quem o usava antes (scripts locais)
    // perde o acesso — daqui em diante o Worker é o único dono do token.
    const corpo = (await req.json().catch(() => ({}))) as { refresh_token?: string };
    if (!corpo.refresh_token) return json({ erro: "informe refresh_token" }, 400);
    try {
      const r2 = await tokenStub(env).semear(corpo.refresh_token);
      await store.log("info", null, "token do ML semeado");
      return json({ ok: true, ...r2 });
    } catch (e) {
      return json({ erro: (e as Error).message }, 502);
    }
  }
  if (req.method === "GET" && p === "/api/meli/access-token") {
    // Para os scripts locais (ml_api.py, vigia de estoque) depois do corte.
    return json({ access_token: await tokenStub(env).accessToken() });
  }
  return json({ erro: "rota não encontrada" }, 404);
}

/** Meia-noite de hoje em São Paulo (UTC−3, sem horário de verão desde 2019), em ms. */
function inicioDoDiaSp(agora = Date.now()): number {
  return agora - ((agora - 3 * 3_600_000) % 86_400_000);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname.startsWith("/ml/webhook/")) {
        const segredo = url.pathname.slice("/ml/webhook/".length);
        if (!forte(env.WEBHOOK_SECRET) || !(await mesmoSegredo(segredo, env.WEBHOOK_SECRET))) return json({ erro: "não encontrado" }, 404);
        return await webhook(req, env, ctx, "segredo");
      }
      if (url.pathname === "/ml/webhook" && req.method === "POST") {
        if (env.WEBHOOK_LEGADO !== "aberto") return json({ erro: "não encontrado" }, 404);
        return await webhook(req, env, ctx, "legado");
      }
      if (url.pathname === "/config" && req.method === "GET") {
        // Diagnóstico público: só diz QUAIS secrets existem e um prefixo do hash do
        // ADMIN_TOKEN (32 bits de um SHA-256) para conferir com o cofre. Nenhum valor.
        // Público só o que a tela de login precisa: URL e chave PUBLICÁVEL do Supabase, que são
        // públicas por natureza. Nomes de secrets, modo e hash saíram (auditoria F3) — o
        // diagnóstico agora é GET /api/admin/config, com login de administrador.
        return json({ supabase: { url: env.SUPABASE_URL, chavePublicavel: env.SUPABASE_PUBLISHABLE_KEY } });
      }
      if (url.pathname === ROTA_SAIDA) return await atenderSaida(req, env);
      if (url.pathname.startsWith("/api/")) return await rotaApi(req, env, url);
      if (url.pathname === "/painel") return Response.redirect(new URL("/", url).toString(), 302);
      return json({ erro: "não encontrado" }, 404);
    } catch (e) {
      console.error("erro não tratado", (e as Error).message);
      return json({ erro: "erro interno" }, 500);
    }
  },

  async scheduled(_ev: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const store = storeStub(env);
    // Marcador de etapa: se a rodada anterior morreu no meio (o Cloudflare mata sem exceção —
    // "internalError"/"exceededResources", 26/09/2026), a próxima registra onde parou.
    const anterior = await store.meta("cron_etapa");
    if (anterior && !anterior.startsWith("fim:")) await store.log("erro", null, `rodada automática anterior morreu na etapa ${anterior.split(":")[0]} (${new Date(Number(anterior.split(":")[1])).toISOString()})`);
    const etapa = (nome: string) => store.setMeta("cron_etapa", `${nome}:${Date.now()}`);
    await etapa("eventos");
    const devidos = await store.eventosDevidos();
    for (const ev of devidos) await processarEvento(env, ev); // sequencial: respeita o ML
    // Fases da Expedição: relê alguns envios impressos para ver se já foram despachados
    // (o webhook "shipments" cobre quase tudo; isto pega o que ele perder).
    await etapa("envios");
    try { await atualizarEnviosPendentes(env, 5); } catch (e) { await store.log("aviso", null, `atualização de envios: ${(e as Error).message}`); }
    await etapa("nfs");
    try {
      await varrerNfs(env, env.XML_MODO === "automatico");
    } catch (e) {
      await store.log("erro", null, `varredura de NF falhou: ${(e as Error).message}`);
    }
    await etapa("estoque");
    try {
      await sincronizarEstoque(env);
    } catch (e) {
      await store.log("erro", null, `sincronização de estoque/preço falhou: ${(e as Error).message}`);
    }
    await etapa("retencao");
    // Retenção de eventos (auditoria F1): 1x por dia apaga os concluídos com mais de 30 dias.
    try {
      if (Date.now() - Number((await store.meta("limpeza_eventos_em")) ?? 0) > 86_400_000) {
        const n = await store.limparEventosAntigos();
        await store.setMeta("limpeza_eventos_em", String(Date.now()));
        if (n) await store.log("info", null, `retenção: ${n} eventos concluídos com mais de 30 dias apagados`);
      }
    } catch (e) { await store.log("aviso", null, `retenção de eventos: ${(e as Error).message}`); }
    await etapa("publicacao");
    // Publicação pelo SKU: candidatos do Sankhya 1x por hora; casamento, fichas e auditoria
    // aos poucos a cada rodada (poucos subrequests — o resto do cron já usa bastante).
    try {
      const erp = await store.meta("pub_erp");
      const em = erp ? Number(JSON.parse(erp).em ?? 0) : 0;
      if (Date.now() - em > 60 * 60_000) await atualizarCandidatos(env);
      await casarPendentes(env, 40);
      await processarFilaFichas(env, 8);
      await auditarPublicacoes(env);
    } catch (e) {
      await store.log("erro", null, `publicação (fila/casamento/auditoria) falhou: ${(e as Error).message}`);
    }
    await store.setMeta("cron_etapa", `fim:${Date.now()}`);
  },
} satisfies ExportedHandler<Env>;
