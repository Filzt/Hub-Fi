// SkyHub — painel. Operação (Pedidos, Expedição), Catálogo (Produtos), Canais de venda
// (Mercado Livre: publicar e precificar) e Sistema (Integrações, Acessos).
// JS puro, sem build. Login pelo Supabase (login.js); cada chamada a /api/* leva o
// access token da sessão e o Worker confere a função da pessoa (auth.ts).
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const brl = (v) => (v == null || v === "" ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const dt = (ms) => (ms ? new Date(ms).toLocaleString("pt-BR") : "—");
const dtIso = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR") : "—");
const hora = (ms) => (ms ? new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—");
// Todo texto visível começa com maiúscula (regra do Filipe, 25/09/2026). Use em valor que vem da API.
const cap = (v) => { const s = String(v ?? ""); return s.charAt(0).toLocaleUpperCase("pt-BR") + s.slice(1); };
const nfDaChave = (k) => (k && k.length === 44 ? String(Number(k.slice(25, 34))) : null);
const haQuanto = (ms) => {
  if (!ms) return "nunca";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "há " + s + " s";
  if (s < 3600) return "há " + Math.round(s / 60) + " min";
  if (s < 86400) return "há " + Math.round(s / 3600) + " h";
  return "há " + Math.round(s / 86400) + " d";
};

let eu = null; // quem está logado: { nome, email, funcao, admin, modulos } de /api/eu
const estado = { fluxoDias: 7, busca: "", filtroProd: "todos" };

async function api(caminho, opt = {}, tentativa = 0) {
  const r = await fetch(caminho, { ...opt, headers: { Authorization: "Bearer " + (await skyAuth.token()), "Content-Type": "application/json" } });
  // Token vencido: renova uma vez e repete; se ainda assim não der, volta para o login.
  if (r.status === 401 && tentativa === 0 && (await skyAuth.renovar())) return api(caminho, opt, 1);
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { eu = null; skyAuth.sair(d.erro || "Sua sessão expirou. Entre de novo."); }
  if (!r.ok) { const e = new Error(d.erro || "Falha HTTP " + r.status); e.status = r.status; throw e; }
  return d;
}

/** Download autenticado (PDF de etiqueta). */
async function baixar(caminho) {
  return fetch(caminho, { headers: { Authorization: "Bearer " + (await skyAuth.token()) } });
}

// Módulos do canal Mercado Livre (item "Mercado Livre" do menu). A Nuvemshop ganha o seu grupo.
const DO_ML = ["publicacao", "precificacao", "flex"];
const grupoDe = (mod) => (DO_ML.includes(mod) ? "ml" : mod);
const permitido = (mod) => {
  if (!eu) return false;
  if (mod === "perfil") return true; // o próprio perfil, qualquer função
  if (mod === "ml") return eu.admin || DO_ML.some((m) => eu.modulos.includes(m));
  if (mod === "flex") mod = "publicacao"; // Envio Flex é permissão de anúncios do ML
  return eu.admin || (mod !== "admin" && eu.modulos.includes(mod));
};
const iniciais = (nome) => String(nome || "?").trim().split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");

/** Chamado pelo login.js quando a pessoa entra (ou já tinha sessão). */
async function entrarNoPainel() {
  try { eu = await api("/api/eu"); }
  catch (e) { eu = null; return skyAuth.sair(e.status === 403 ? e.message : "Não consegui carregar seu acesso: " + e.message); }
  $$("nav a[data-mod]").forEach((a) => { a.hidden = !permitido(a.dataset.mod); });
  $$("nav a[data-perm]").forEach((a) => { a.hidden = !permitido(a.dataset.perm); });
  $$("nav [data-mod-breve]").forEach((a) => { a.hidden = !permitido(a.dataset.modBreve); });
  // "Mercado Livre" abre a primeira tela que a função pode ver; seção sem item visível some.
  $('nav a[data-mod="ml"]').href = permitido("publicacao") ? "#publicacao" : "#precificacao";
  $$("nav .nav-secao").forEach((s) => { s.hidden = !$$("a[data-mod]", s).some((a) => !a.hidden); });
  $("#usuario").hidden = false;
  $("#usuario-nome").textContent = eu.nome || eu.email;
  $("#usuario-funcao").textContent = [eu.funcao, "Skyline"].filter(Boolean).join(" · ");
  $("#usuario-avatar").textContent = iniciais(eu.nome || eu.email);
  atualizarContagemExpedicao();
  navegar();
}

/** Aviso curto de sucesso (some sozinho). */
function avisar(texto) {
  const a = $("#aviso");
  a.textContent = cap(texto);
  a.hidden = false;
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => { a.hidden = true; }, 3500);
}
window.avisar = avisar;
const post = (caminho, corpo) => api(caminho, { method: "POST", body: corpo ? JSON.stringify(corpo) : undefined });

// Botão de atualizar só com o ícone: as telas de Pedidos e Expedição já se atualizam
// sozinhas a cada minuto; o botão serve para forçar na hora.
const AUTO_MS = 60_000;
const btnAtualizar = (id, titulo) =>
  '<button id="' + id + '" type="button" class="icone" title="' + esc(titulo) + '" aria-label="' + esc(titulo) + '">↻</button>' +
  '<span class="atualizado mut" data-atualizado>Atualizado ' + esc(hora(Date.now())) + "</span>";
const marcarAtualizado = () => $$("[data-atualizado]").forEach((el) => { el.textContent = "Atualizado " + hora(Date.now()); });

function erro(e) { $("#msg-txt").textContent = cap(e && e.message ? e.message : String(e)); $("#msg").hidden = false; }
function limparErro() { $("#msg-txt").textContent = ""; $("#msg").hidden = true; }
const carregando = (txt = "Carregando…") => '<div class="carregando">' + esc(txt) + "</div>";

/* ------------------------------------------------------------------ roteamento */
const MODULOS = {
  pedidos: { titulo: "Pedidos", render: renderPedidos, desc: "Todas as vendas dos canais, da entrada até a entrega." },
  expedicao: { titulo: "Expedição", render: renderExpedicao },
  produtos: { titulo: "Produtos", render: renderProdutos, desc: "Cada SKU do Sankhya e em quais canais de venda ele está." },
  publicacao: { titulo: "Publicar anúncios", render: renderPublicacao, canal: "Mercado Livre" },
  precificacao: { titulo: "Precificação", render: renderPrecificacao, canal: "Mercado Livre", desc: "Régua que transforma o preço de loja do Sankhya no preço do anúncio." },
  flex: { titulo: "Envio Flex", render: renderFlex, canal: "Mercado Livre", desc: "Quais anúncios oferecem entrega no mesmo dia pelo Flex. Liga e desliga por anúncio, sempre por clique." },
  integracao: { titulo: "Integrações", render: renderIntegracao },
  admin: { titulo: "Acessos", render: renderAdmin },
  perfil: { titulo: "Meu perfil", render: renderPerfil, desc: "Seu nome, e-mail de acesso e senha." },
};
const PADRAO_SUB = { integracao: "visao", expedicao: "imprimir", admin: "usuarios", publicacao: "fila", precificacao: "ml", flex: "lista" };
const SUBTITULOS = {
  integracao: { visao: "Visão geral", nfs: "NF-e → ML", logs: "Logs", eventos: "Eventos" },
  expedicao: { agendados: "Agendados", imprimir: "Para imprimir", impressos: "Impressos", despachados: "Despachados" },
  admin: { usuarios: "Usuários", funcoes: "Funções" },
  publicacao: { historico: "Histórico" },
};
const DESC_SUB = {
  "integracao/visao": "Saúde da ligação entre os canais, o SkyHub e o Sankhya.",
  "integracao/nfs": "Notas faturadas no Sankhya e o envio do XML ao Mercado Livre.",
  "integracao/logs": "Registro do que o SkyHub fez, com erros e avisos.",
  "integracao/eventos": "Notificações recebidas dos canais e o processamento de cada uma.",
  "expedicao/agendados": "O Mercado Livre segura a etiqueta até a data de liberação.",
  "expedicao/imprimir": "Bipe a etiqueta ou marque várias para imprimir de uma vez.",
  "expedicao/impressos": "Etiquetas impressas, aguardando despacho na agência ou coleta.",
  "expedicao/despachados": "Envios que o Mercado Livre registrou como despachados hoje.",
  "admin/usuarios": "Quem entra no SkyHub e com qual função.",
  "admin/funcoes": "O que cada função pode ver e fazer.",
  "publicacao/fila": "SKUs com saldo no Sankhya e sem anúncio, com a ficha do ML sugerida. Nada vai ao ar sem o seu clique.",
  "publicacao/historico": "Tudo o que foi publicado pelo SkyHub e a auditoria de cada anúncio.",
};

function rota() {
  const [mod, sub] = (location.hash.replace(/^#/, "") || "pedidos").split("/");
  const m = MODULOS[mod] ? mod : "pedidos";
  return { mod: m, sub: sub || PADRAO_SUB[m] || "" };
}

async function navegar() {
  if (!eu) return; // o login.js chama entrarNoPainel quando houver sessão
  let { mod, sub } = rota();
  if (!permitido(mod)) {
    // Função sem acesso a este módulo: vai para o primeiro que ela pode ver.
    const primeiro = Object.keys(MODULOS).find(permitido);
    if (!primeiro) { $("#conteudo").innerHTML = '<p class="vazio">Sua função ainda não tem nenhum módulo liberado. Fale com o administrador.</p>'; return; }
    if (primeiro !== mod) { location.hash = "#" + primeiro; return; }
  }
  // Menu: cada item acende com o seu grupo e abre o próprio submenu.
  const grupo = grupoDe(mod);
  $$("nav a[data-mod]").forEach((a) => a.classList.toggle("ativo", a.dataset.mod === grupo));
  $$("nav .submenu[data-grupo]").forEach((s) => s.classList.toggle("aberto", s.dataset.grupo === grupo));
  $$("nav a[data-rota]").forEach((a) => a.classList.toggle("ativo", a.dataset.rota === mod + "/" + sub));
  fecharMenuMobile();
  // Topo: canal em cima (kicker), título do módulo · subtela, e uma linha dizendo para que serve.
  const m = MODULOS[mod];
  const subtitulo = (SUBTITULOS[mod] || {})[sub] || "";
  $("#kicker").textContent = m.canal || "";
  $("#kicker").hidden = !m.canal;
  $("#titulo").textContent = m.titulo + (subtitulo ? " · " + subtitulo : "");
  $("#desc").textContent = DESC_SUB[mod + "/" + sub] || m.desc || "";
  document.title = m.titulo + " · SkyHub";
  limparErro();
  $("#conteudo").innerHTML = carregando();
  try { await MODULOS[mod].render(sub); } catch (e) { erro(e); $("#conteudo").innerHTML = ""; }
}

/** Menu no celular: abre e fecha pelo botão; fecha sozinho ao trocar de tela. */
function fecharMenuMobile() {
  $("#lateral").classList.remove("aberta");
  $("#abrir-menu").setAttribute("aria-expanded", "false");
}
$("#abrir-menu").addEventListener("click", () => {
  const aberta = $("#lateral").classList.toggle("aberta");
  $("#abrir-menu").setAttribute("aria-expanded", String(aberta));
});
$("#fechar-msg").addEventListener("click", limparErro);

/** Selo do canal de origem (pedido, envio). Hoje todo pedido é do ML. */
const SELOS = { ml: '<span class="selo-canal" title="Mercado Livre">ML</span>' };
const seloCanal = (canal) => SELOS[canal || "ml"] || "";

/* ------------------------------------------------------------------ Pedidos */
const FASE_INFO = {
  novo: { nome: "Recebido", desc: "Venda no ML, fora do Sankhya" },
  erp: { nome: "No Sankhya", desc: "Pedido 1090, aguardando NF" },
  faturado: { nome: "Faturado", desc: "NF autorizada, sem XML no ML" },
  nf_ml: { nome: "NF no ML", desc: "XML aceito, etiqueta liberada" },
  etiqueta: { nome: "Etiqueta impressa", desc: "Aguardando coleta" },
  enviado: { nome: "Enviado", desc: "Saiu para entrega" },
  atencao: { nome: "Atenção", desc: "Bloqueado ou com erro" },
  cancelado: { nome: "Cancelados", desc: "Cancelados no ML" },
};

async function renderPedidos() {
  const d = await api("/api/fluxo?dias=" + estado.fluxoDias);
  const busca = estado.busca.trim();
  const pedidos = busca ? d.pedidos.filter((p) => String(p.chave).includes(busca) || String(p.order_ids).includes(busca) || String(p.nunota ?? "").includes(busca)) : d.pedidos;
  const porFase = Object.fromEntries(d.fases.map((f) => [f, pedidos.filter((p) => p.fase === f)]));
  const barra = '<div class="barra">' +
    '<label for="dias" class="mut">Período</label><select id="dias">' +
    [1, 7, 15, 30].map((n) => '<option value="' + n + '"' + (n === estado.fluxoDias ? " selected" : "") + ">" + (n === 1 ? "Últimas 24 h" : "Últimos " + n + " dias") + "</option>").join("") +
    '</select><input id="busca-ped" type="search" placeholder="Nº do ML ou NUNOTA" value="' + esc(estado.busca) + '" aria-label="Buscar pedido">' +
    '<span class="espaco"></span>' + btnAtualizar("recarregar-ped", "Atualizar agora (a tela já se atualiza a cada minuto)") + "</div>";
  const colunas = d.fases.map((f) => {
    const lista = porFase[f];
    const imprimiveis = lista.filter((p) => p.shipment_id && (p.envio_substatus === "ready_to_print" || p.envio_substatus === "printed"));
    const acaoColuna = (f === "nf_ml" && imprimiveis.length)
      ? '<button type="button" class="primario" data-imprimir="' + esc(imprimiveis.map((p) => p.shipment_id).join(",")) + '">Imprimir etiquetas (' + imprimiveis.length + ")</button>" : "";
    return '<div class="coluna ' + f + '"><div class="coluna-topo"><div class="t">' + esc(FASE_INFO[f].nome) + '<span class="qtd">' + lista.length + "</span></div>" +
      '<div class="desc" title="' + esc(FASE_INFO[f].desc) + '">' + esc(FASE_INFO[f].desc) + '</div></div><div class="coluna-corpo">' + acaoColuna +
      (lista.length ? lista.map(cartaoPedido).join("") : '<span class="mut">Nenhum</span>') + "</div></div>";
  }).join("");
  $("#conteudo").innerHTML = barra + '<div class="esteira">' + colunas + "</div>";
  $("#dias").onchange = (e) => { estado.fluxoDias = Number(e.target.value); navegar(); };
  $("#busca-ped").oninput = (e) => { estado.busca = e.target.value; clearTimeout(renderPedidos.t); renderPedidos.t = setTimeout(navegar, 300); };
  $("#recarregar-ped").onclick = navegar;
}

function cartaoPedido(p) {
  const tags = [];
  if (p.nunota) tags.push('<span class="tag">Pedido ' + esc(p.nunota) + "</span>");
  const nf = nfDaChave(p.fiscal_key);
  if (nf) tags.push('<span class="tag info">NF ' + esc(nf) + "</span>");
  if (p.situacao === "aguardando_comissao") tags.push('<span class="tag warn">Aguardando comissão</span>');
  if (p.situacao === "aguardando_pagamento") tags.push('<span class="tag warn">Aguardando pagamento</span>');
  if (p.situacao === "pronto") tags.push('<span class="tag info">Pronto p/ gravar</span>');
  if (p.gravacao === "erro") tags.push('<span class="tag err">Erro na gravação</span>');
  if (p.nf_status === "erro" || p.nf_status === "divergente") tags.push('<span class="tag err">NF: ' + esc(p.nf_status) + "</span>");
  if (p.cancelamento) tags.push('<span class="tag ' + (/^cancelado/.test(p.cancelamento) ? "ok" : "warn") + '">' + esc(cap(p.cancelamento.split(":")[0])) + "</span>");
  return '<button type="button" class="ped" data-ped="' + esc(p.chave) + '"><div class="l1"><span class="ch">' + seloCanal(p.canal) + " …" + esc(String(p.chave).slice(-8)) + '</span><span class="vl">' + brl(p.total) + "</span></div>" +
    '<div class="l2">' + esc(dtIso(p.data_ml)) + (p.codparc ? " · Parceiro " + esc(p.codparc) : "") + '</div><div class="l3">' + tags.join("") + "</div></button>";
}

async function abrirPedido(chave) {
  const d = await api("/api/pedidos/" + encodeURIComponent(chave));
  const p = d.pedido;
  const fl = (await api("/api/fluxo?dias=60")).pedidos.find((x) => x.chave === chave) || {};
  const a = JSON.parse(p.analise_json || "{}");
  const orderId = String(p.order_ids).split(",")[0];
  const acoes = [];
  if (p.situacao === "pronto") acoes.push('<button type="button" class="primario" data-acao="gravar" data-order="' + esc(orderId) + '">Gravar no Sankhya</button>');
  if (fl.nf_status === "pronto" || fl.nf_status === "erro") acoes.push('<button type="button" class="primario" data-acao="xml" data-chave="' + esc(chave) + '">Enviar XML ao ML</button>');
  if (fl.shipment_id && (fl.envio_substatus === "ready_to_print" || fl.envio_substatus === "printed")) {
    acoes.push('<button type="button" data-imprimir="' + esc(fl.shipment_id) + '">' + (fl.envio_substatus === "printed" ? "Reimprimir etiqueta" : "Imprimir etiqueta") + "</button>");
  }
  acoes.push('<button type="button" data-acao="reprocessar" data-order="' + esc(orderId) + '">Reprocessar</button>');
  const nf = nfDaChave(fl.fiscal_key);
  $("#gaveta-titulo").textContent = "Pedido " + chave;
  $("#gaveta-corpo").innerHTML =
    '<div class="acoes">' + acoes.join("") + "</div>" +
    '<dl class="dados"><dt>Fase</dt><dd>' + esc((FASE_INFO[fl.fase] || {}).nome || "—") + "</dd>" +
    "<dt>Data no ML</dt><dd>" + esc(dtIso(p.data_ml)) + "</dd><dt>Status no ML</dt><dd>" + esc(cap(p.status_ml)) + "</dd>" +
    "<dt>Orders</dt><dd>" + esc(p.order_ids) + "</dd><dt>Total</dt><dd>" + brl(p.total) + "</dd>" +
    "<dt>Comissão ML</dt><dd>" + brl(p.comissao) + "</dd><dt>Frete cobrado</dt><dd>" + brl(p.frete) + "</dd>" +
    "<dt>Parceiro</dt><dd>" + esc(p.codparc ?? "novo") + "</dd><dt>Pedido Sankhya</dt><dd>" + esc(p.nunota ?? "—") + (p.gravacao ? " (" + esc(p.gravacao) + ")" : "") + "</dd>" +
    "<dt>NF</dt><dd>" + (nf ? esc(nf) + " · NUNOTA " + esc(fl.nunota_nf) : "—") + (fl.nf_status ? " · " + esc(cap(fl.nf_status)) : "") + "</dd>" +
    "<dt>Envio</dt><dd>" + esc(fl.shipment_id ?? "—") + (fl.envio_status ? " · " + esc(cap(fl.envio_status)) + "/" + esc(fl.envio_substatus || "-") : "") + "</dd>" +
    (p.cancelamento ? "<dt>Cancelamento</dt><dd>" + esc(cap(p.cancelamento)) + "</dd>" : "") +
    (a.bloqueio ? '<dt>Bloqueio</dt><dd class="err">' + esc(cap(a.bloqueio)) + "</dd>" : "") +
    (p.gravacao_erro ? '<dt>Erro</dt><dd class="err">' + esc(cap(p.gravacao_erro)) + "</dd>" : "") + "</dl>" +
    (a.alertas && a.alertas.length ? "<div><b>Alertas</b><pre>" + a.alertas.map((x) => esc(cap(x))).join("<br>") + "</pre></div>" : "") +
    "<div><b>Itens</b><pre>" + esc(JSON.stringify(a.itens || [], null, 2)) + "</pre></div>" +
    '<details><summary>Nota montada (incluirNota)</summary><pre>' + esc(p.nota_json ? JSON.stringify(JSON.parse(p.nota_json), null, 2) : "—") + "</pre></details>";
  $("#gaveta").hidden = false;
}

async function imprimirEtiquetas(ids) {
  const lista = ids.split(",").filter(Boolean);
  if (lista.length > 20) throw new Error("Máximo de 20 etiquetas por vez.");
  if (!confirm("Baixar " + lista.length + " etiqueta(s) 10x15? O ML marca os envios como impressos.")) return;
  const r = await baixar("/api/etiquetas/baixar?formato=pdf&ids=" + lista.join(","));
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.erro || "Falha HTTP " + r.status); }
  const url = URL.createObjectURL(await r.blob());
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  navegar();
}

/* ------------------------------------------------------------------ Expedição */
// Lista só as etiquetas liberadas (NF aceita pelo ML) e um campo para bipar.
// O leitor manda o código + Enter: 1º Enter localiza, 2º Enter (ou o botão) imprime.
// Aceita nº do pedido ML (pack ou order), nº do envio (código grande da etiqueta),
// chave da NF (44 dígitos) ou número da NF.
// Todo bipe passa antes pela checagem ao vivo no ML (/api/expedicao/checar): venda
// cancelada abre o alerta "Pedido cancelado — não envie" e não imprime.
// Seleção múltipla: checkbox por linha + "Imprimir selecionadas" (até 20, teto do PDF).
// O campo esvazia depois de cada leitura; bipar o mesmo código de novo (ou Enter vazio) imprime.
const expedicao = { lista: [], achado: null, ultimoBipe: "", sel: new Set(), fase: "imprimir", outros: [] };
// Fases (submenus): Agendados (ML segura a etiqueta até a data) → Para imprimir → Impressos
// → Despachados (bipado na agência, visto no ML). Agendados e Despachados só listam.
const FASES_SO_LISTA = ["agendados", "despachados"];
/** Data de liberação do ML ("2026-09-28T00:00:00.000Z" é o DIA 28, não 21h do dia 27). */
const diaLiberacao = (iso) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit" }) : "Data não informada");
// Flex: o ML libera a etiqueta sem esperar a NF. Só imprime com a NF já anexada no ML
// (o servidor recusa também — etiquetas.ts).
const ehFlex = (e) => e.logistica === "self_service";
const flexSemNf = (e) => ehFlex(e) && !(e.fiscal_key && ["enviado", "ja_no_ml"].includes(e.nf_status));
const FASE_EXP = {
  imprimir: (e) => e.substatus === "ready_to_print",
  impressos: (e) => e.substatus === "printed",
};

/** Números dos submenus da Expedição. Silencioso: falha aqui não atrapalha a tela. */
async function atualizarContagemExpedicao() {
  if (!permitido("expedicao")) return;
  try {
    const c = await api("/api/expedicao/contagem");
    for (const [k, v] of Object.entries(c)) {
      const el = $('.qtd[data-qtd="' + k + '"]');
      if (el) { el.textContent = String(v); el.classList.toggle("alta", k === "imprimir" && v > 0); }
    }
  } catch { /* mantém o último número */ }
}

/** O campo de bipe fica sempre pronto: volta o cursor para ele quando a tela é atualizada ou a impressão fecha. */
function focarBipe() {
  const campo = $("#bipe");
  if (!campo || !$("#cancelado").hidden) return;
  const ativo = document.activeElement;
  if (ativo && ativo !== document.body && ativo !== campo && ativo.matches("input, select, textarea")) return;
  campo.focus();
}
const MAX_SEL = 20;

function alertarCancelado(c) {
  $("#cancelado-detalhe").innerHTML = "Pedido ML <b>" + esc(c.pedido || c.codigo) + "</b>" +
    (c.motivo ? "<br>" + esc(cap(c.motivo)) : "") + (c.envio_status ? "<br>Envio: " + esc(c.envio_status) : "");
  $("#cancelado").hidden = false;
  $(".alerta-caixa").focus(); // foco na caixa: o Enter do leitor não fecha o alerta sozinho
}

/** Vários cancelados de uma vez (impressão em lote). */
function alertarCancelados(lista) {
  if (lista.length === 1) return alertarCancelado(lista[0]);
  alertarCancelado({ pedido: lista.map((c) => c.pedido || c.codigo).join(", "), motivo: lista.length + " pedidos selecionados foram cancelados no Mercado Livre. Nada foi impresso." });
}

function fecharCancelado() {
  $("#cancelado").hidden = true;
  const campo = $("#bipe");
  if (campo) { campo.value = ""; campo.focus(); }
}

/** Confere no ML se o pedido do código bipado foi cancelado. true = pode seguir. */
async function checarCancelamento(codigo) {
  const c = await api("/api/expedicao/checar?codigo=" + encodeURIComponent(codigo));
  if (c.agendado) {
    expedicao.achado = null; expedicao.ultimoBipe = "";
    $("#resultado-bipe").innerHTML = '<div class="nao-achado">Pedido ' + esc(c.pedido || codigo) + " é <b>agendado</b> pelo Mercado Livre: a etiqueta só é liberada " +
      esc(diaLiberacao(c.liberacao)) + ". Guarde a caixa e não envie antes.</div>";
    return false;
  }
  if (c.cancelado) {
    expedicao.achado = null; expedicao.ultimoBipe = "";
    $("#resultado-bipe").innerHTML = '<div class="nao-achado">Pedido ' + esc(c.pedido || codigo) + " CANCELADO — não envie.</div>";
    alertarCancelado(c);
    return false;
  }
  return true;
}

function casaBipe(e, codigo) {
  const c = codigo.replace(/\D/g, "");
  if (!c) return false;
  const nf = nfDaChave(e.fiscal_key);
  return [e.chave, e.envio_order, e.shipment_id, e.fiscal_key].concat(String(e.order_ids || "").split(","))
    .some((v) => v && String(v) === c) || (nf && nf === String(Number(c)) && c.length <= 9);
}

async function renderExpedicao(sub) {
  expedicao.fase = FASE_EXP[sub] || FASES_SO_LISTA.includes(sub) ? sub : "imprimir";
  const soLista = FASES_SO_LISTA.includes(expedicao.fase);
  const [d, outros] = await Promise.all([
    api("/api/etiquetas"),
    soLista ? api("/api/etiquetas?fase=" + expedicao.fase) : Promise.resolve({ etiquetas: [] }),
  ]);
  expedicao.lista = d.etiquetas; // o bipe procura em tudo que ainda dá para imprimir, qualquer que seja a aba
  expedicao.outros = outros.etiquetas;
  atualizarContagemExpedicao();
  const prontas = d.etiquetas.filter((e) => e.substatus === "ready_to_print").length;
  $("#conteudo").innerHTML =
    '<div class="bipe"><label for="bipe">Bipar etiqueta</label><input id="bipe" inputmode="numeric" autocomplete="off" placeholder="Leia o código do pedido">' +
    '<button type="button" id="limpar-bipe" class="icone" title="Limpar" aria-label="Limpar"><svg class="ico"><use href="#i-lixo"/></svg></button>' + btnAtualizar("atualizar-exp", "Atualizar agora: relê os envios no Mercado Livre (a tela já se atualiza a cada minuto)") +
    "</div>" +
    '<div id="resultado-bipe"></div>' +
    '<div class="cards"><div class="card"><b id="n-prontas">' + prontas + '</b><span>Para imprimir</span></div><div class="card"><b id="n-impressas">' + (d.etiquetas.length - prontas) + '</b><span>Impressas, aguardando despacho</span></div></div>' +
    (expedicao.fase === "despachados" ? '<p class="dica">Despachados hoje: o ML registrou a entrada do pacote na agência ou coleta.</p>' : "") +
    (expedicao.fase === "agendados" ? '<p class="dica">Agendados pelo Mercado Livre: a etiqueta só é liberada na data indicada. Separe a caixa e aguarde; a NF sobe sozinha quando o ML liberar.</p>' : "") +
    '<div class="acoes-sel"' + (soLista ? " hidden" : "") + '><button type="button" class="primario" id="imprimir-sel" disabled>Imprimir selecionadas</button><span class="dica" id="info-sel"></span></div>' +
    '<div class="painel"><table><thead><tr><th class="sel">' + (soLista ? "" : '<input type="checkbox" id="sel-todas" aria-label="Selecionar todas as visíveis">') + '</th><th>Pedido</th><th>NF</th><th>Envio</th><th>Venda</th><th class="n">Total</th><th>Situação</th><th></th></tr></thead><tbody id="tb-exp"></tbody></table></div>';
  // Seleção que ficou de uma lista anterior só vale para envios ainda liberados.
  const ids = new Set(d.etiquetas.map((e) => e.shipment_id));
  expedicao.sel = new Set([...expedicao.sel].filter((id) => ids.has(id)));
  desenharExpedicao();
  $("#tb-exp").addEventListener("change", (ev) => {
    const cx = ev.target.closest("input[data-sel]");
    if (!cx) return;
    if (cx.checked) {
      if (expedicao.sel.size >= MAX_SEL) { cx.checked = false; erro("Máximo de " + MAX_SEL + " etiquetas por impressão."); return; }
      expedicao.sel.add(cx.dataset.sel);
    } else expedicao.sel.delete(cx.dataset.sel);
    atualizarSelecao();
  });
  if ($("#sel-todas")) $("#sel-todas").addEventListener("change", (ev) => {
    // Checkbox do cabeçalho marca só a página aberta (até 20).
    const visiveis = $$("#tb-exp input[data-sel]:not(:disabled)").map((c) => c.dataset.sel);
    if (ev.target.checked) {
      for (const id of visiveis) {
        if (expedicao.sel.size >= MAX_SEL) { erro("Selecionei as primeiras " + MAX_SEL + " (máximo por impressão)."); break; }
        expedicao.sel.add(id);
      }
    } else visiveis.forEach((id) => expedicao.sel.delete(id));
    desenharExpedicao();
  });
  $("#imprimir-sel").onclick = (ev) => imprimirSelecionadas(ev.target).catch(erro);
  const campo = $("#bipe");
  campo.focus();
  campo.addEventListener("keydown", async (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const codigo = campo.value.trim();
    try {
      if (expedicao.achado && (!codigo || codigo === expedicao.ultimoBipe)) return await imprimirExpedicao(expedicao.achado);
      if (!codigo) return;
      $("#resultado-bipe").innerHTML = '<div class="achado checando">Conferindo o pedido no Mercado Livre…</div>';
      let seguir = true;
      try { seguir = await checarCancelamento(codigo); }
      catch (e) { erro("Não consegui conferir o cancelamento no ML (" + e.message + "). Confira no painel do ML antes de enviar."); }
      if (!seguir) { campo.value = ""; return; }
      localizar(codigo);
      campo.value = ""; // pronto para o próximo bipe
    } catch (e) { erro(e); campo.value = ""; }
  });
  $("#limpar-bipe").onclick = () => { expedicao.achado = null; expedicao.ultimoBipe = ""; campo.value = ""; desenharExpedicao(); campo.focus(); };
  $("#atualizar-exp").onclick = async (e) => {
    e.target.disabled = true;
    try { await post("/api/etiquetas/atualizar"); await recarregarExpedicao(); } catch (x) { erro(x); } finally { e.target.disabled = false; }
  };
}

function localizar(codigo) {
  limparErro();
  expedicao.ultimoBipe = codigo;
  const achados = expedicao.lista.filter((e) => casaBipe(e, codigo));
  expedicao.achado = achados.length === 1 ? achados[0] : null;
  const alvo = $("#resultado-bipe");
  if (achados.length === 1 && flexSemNf(achados[0])) {
    expedicao.achado = null;
    alvo.innerHTML = '<div class="nao-achado">Pedido ' + esc(achados[0].chave) + " é <b>Flex</b> e ainda está sem NF no Mercado Livre. Fature e envie a NF antes de imprimir (entrega hoje).</div>";
  } else if (achados.length === 1) {
    const e = achados[0];
    alvo.innerHTML = '<div class="achado"><div><div class="mut">Pedido ML</div><div class="grande">' + esc(e.chave) + "</div></div>" +
      '<div><div class="mut">NF</div><div class="grande">' + esc(nfDaChave(e.fiscal_key) || "—") + "</div></div>" +
      '<div><div class="mut">Situação</div><div>' + (e.substatus === "ready_to_print" ? '<span class="tag info">Para imprimir</span>' : '<span class="tag ok">Já impressa ' + esc(dt(e.impresso_em)) + "</span>") + "</div></div>" +
      '<button type="button" class="primario" id="imprimir-achado">' + (e.substatus === "printed" ? "Reimprimir" : "Imprimir") + " etiqueta (Enter)</button></div>";
    $("#imprimir-achado").onclick = () => imprimirExpedicao(e).catch(erro);
  } else {
    alvo.innerHTML = '<div class="nao-achado">' + (achados.length ? achados.length + " etiquetas batem com esse código — use o número do envio." :
      "Nenhuma etiqueta liberada para “" + esc(codigo) + "”. Confira se a NF já foi faturada e enviada ao ML, ou clique em ↻ para reler no ML.") + "</div>";
  }
  desenharExpedicao();
}

function desenharExpedicao() {
  if (expedicao.fase === "despachados") return desenharDespachados();
  if (expedicao.fase === "agendados") return desenharAgendados();
  const focoId = expedicao.achado && expedicao.achado.shipment_id;
  // O bipe acha em qualquer fase imprimível; sem bipe, a tabela mostra só a aba atual.
  const linhas = focoId ? expedicao.lista.filter((e) => e.shipment_id === focoId) : expedicao.lista.filter(FASE_EXP[expedicao.fase]);
  $("#tb-exp").innerHTML = linhas.map((e) => '<tr class="' + (e.shipment_id === focoId ? "foco" : "") + (expedicao.sel.has(e.shipment_id) ? " sel" : "") + '">' +
    '<td class="sel"><input type="checkbox" data-sel="' + esc(e.shipment_id) + '"' + (expedicao.sel.has(e.shipment_id) ? " checked" : "") + (flexSemNf(e) ? " disabled" : "") +
    ' aria-label="Selecionar pedido ' + esc(e.chave || e.shipment_id) + '"></td><td>' + seloCanal(e.canal) + " <b>" + esc(e.chave || "—") + "</b>" +
    (ehFlex(e) ? ' <span class="tag warn" title="Envio Flex: entrega no mesmo dia">Flex · hoje</span>' : "") + "</td><td>" +
    esc(nfDaChave(e.fiscal_key) || "—") + "</td><td>" + esc(e.shipment_id) + "</td><td>" + esc(dtIso(e.data_ml)) + '</td><td class="n">' + brl(e.total) + "</td><td>" +
    (flexSemNf(e) ? '<span class="tag err">Aguardando NF</span>' : e.substatus === "ready_to_print" ? '<span class="tag info">Para imprimir</span>' : '<span class="tag ok">Já impressa</span>') +
    '</td><td><button type="button" data-exp="' + esc(e.shipment_id) + '"' + (flexSemNf(e) ? ' disabled title="Flex sem NF no ML"' : "") + ">" + (e.substatus === "printed" ? "Reimprimir" : "Imprimir") + "</button></td></tr>").join("") ||
    '<tr><td colspan="8" class="mut">Nenhuma etiqueta liberada agora.</td></tr>';
  atualizarSelecao();
}

/**
 * Recarga silenciosa da Expedição: busca as listas de novo e redesenha só a tabela e os
 * números — mantém o que foi bipado, a seleção e o que está digitado no campo.
 */
async function recarregarExpedicao() {
  const soLista = FASES_SO_LISTA.includes(expedicao.fase);
  const [d, outros] = await Promise.all([
    api("/api/etiquetas"),
    soLista ? api("/api/etiquetas?fase=" + expedicao.fase) : Promise.resolve({ etiquetas: [] }),
  ]);
  if (rota().mod !== "expedicao") return; // saiu da tela enquanto buscava
  expedicao.lista = d.etiquetas;
  expedicao.outros = outros.etiquetas;
  const ids = new Set(d.etiquetas.map((e) => e.shipment_id));
  expedicao.sel = new Set([...expedicao.sel].filter((id) => ids.has(id)));
  if (expedicao.achado) expedicao.achado = d.etiquetas.find((e) => e.shipment_id === expedicao.achado.shipment_id) || expedicao.achado;
  const prontas = d.etiquetas.filter((e) => e.substatus === "ready_to_print").length;
  if ($("#n-prontas")) $("#n-prontas").textContent = String(prontas);
  if ($("#n-impressas")) $("#n-impressas").textContent = String(d.etiquetas.length - prontas);
  desenharExpedicao();
  atualizarContagemExpedicao();
  marcarAtualizado();
}

function desenharAgendados() {
  $("#tb-exp").innerHTML = expedicao.outros.map((e) => "<tr><td></td><td><b>" + esc(e.chave || "—") + "</b></td><td>" + esc(nfDaChave(e.fiscal_key) || "—") +
    "</td><td>" + esc(e.shipment_id) + "</td><td>" + esc(dtIso(e.data_ml)) + '</td><td class="n">' + brl(e.total) + "</td><td>" +
    '<span class="tag warn">Libera ' + esc(diaLiberacao(e.liberacao)) + "</span></td><td></td></tr>").join("") ||
    '<tr><td colspan="8" class="mut">Nenhum pedido agendado.</td></tr>';
}

function desenharDespachados() {
  $("#tb-exp").innerHTML = expedicao.outros.map((e) => "<tr><td></td><td><b>" + esc(e.chave || "—") + "</b></td><td>" + esc(nfDaChave(e.fiscal_key) || "—") +
    "</td><td>" + esc(e.shipment_id) + "</td><td>" + esc(dtIso(e.data_ml)) + '</td><td class="n">' + brl(e.total) + "</td><td>" +
    '<span class="tag ok">Despachado ' + esc(dt(e.despachado_em)) + '</span> <span class="mut">' + esc(cap([e.status, e.substatus].filter(Boolean).join(" / "))) + "</span></td><td></td></tr>").join("") ||
    '<tr><td colspan="8" class="mut">Nenhum envio despachado hoje.</td></tr>';
}

function atualizarSelecao() {
  const n = expedicao.sel.size;
  const bt = $("#imprimir-sel");
  if (!bt) return;
  bt.disabled = n === 0;
  bt.textContent = n ? "Imprimir selecionadas (" + n + ")" : "Imprimir selecionadas";
  $("#info-sel").textContent = n ? "" : "Marque as etiquetas na lista para imprimir várias de uma vez (até " + MAX_SEL + ").";
  const visiveis = $$("#tb-exp input[data-sel]");
  visiveis.forEach((c) => c.closest("tr").classList.toggle("sel", c.checked));
  const todas = $("#sel-todas");
  if (todas) todas.checked = visiveis.length > 0 && visiveis.every((c) => c.checked);
}

/** Lote: confere o cancelamento de cada selecionada no ML; se alguma caiu, não imprime nada. */
async function imprimirSelecionadas(bt) {
  const escolhidas = expedicao.lista.filter((e) => expedicao.sel.has(e.shipment_id));
  if (!escolhidas.length) return;
  limparErro();
  bt.disabled = true;
  try {
    const cancelados = [];
    for (let i = 0; i < escolhidas.length; i++) {
      bt.textContent = "Conferindo " + (i + 1) + " de " + escolhidas.length + "…";
      const c = await api("/api/expedicao/checar?codigo=" + encodeURIComponent(escolhidas[i].shipment_id));
      if (c.cancelado) cancelados.push(c);
    }
    if (cancelados.length) {
      const fora = new Set(cancelados.map((c) => c.shipment_id));
      escolhidas.forEach((e) => { if (fora.has(e.shipment_id)) expedicao.sel.delete(e.shipment_id); });
      desenharExpedicao();
      $("#resultado-bipe").innerHTML = '<div class="nao-achado">' + cancelados.length + " pedido(s) cancelado(s) desmarcado(s). Confira a seleção e imprima de novo.</div>";
      return alertarCancelados(cancelados);
    }
    await imprimirPdf(escolhidas.map((e) => e.shipment_id));
    escolhidas.forEach((e) => { e.substatus = "printed"; e.impresso_em = Date.now(); });
    expedicao.sel.clear();
    atualizarContagemExpedicao();
    $("#resultado-bipe").innerHTML = '<div class="achado"><span class="ok">' + escolhidas.length + " etiqueta(s) enviada(s) para impressão.</span></div>";
    desenharExpedicao();
  } finally {
    atualizarSelecao();
  }
}

/** Baixa o PDF 10x15 dos envios e manda para a impressora (iframe oculto). */
async function imprimirPdf(ids) {
  const r = await baixar("/api/etiquetas/baixar?formato=pdf&ids=" + ids.map(encodeURIComponent).join(","));
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.erro || "Falha HTTP " + r.status); }
  const url = URL.createObjectURL(await r.blob());
  // Imprime direto num iframe oculto; se o navegador bloquear, abre o PDF numa aba.
  const quadro = document.createElement("iframe");
  quadro.style.cssText = "position:absolute;width:0;height:0;border:0";
  quadro.src = url;
  quadro.onload = () => {
    try { quadro.contentWindow.focus(); quadro.contentWindow.print(); } catch { window.open(url, "_blank"); }
    setTimeout(() => { quadro.remove(); URL.revokeObjectURL(url); }, 120000);
  };
  document.body.appendChild(quadro);
}

async function imprimirExpedicao(e) {
  await imprimirPdf([e.shipment_id]);
  setTimeout(atualizarContagemExpedicao, 1500);
  e.substatus = "printed"; e.impresso_em = Date.now();
  expedicao.achado = null; expedicao.ultimoBipe = "";
  const campo = $("#bipe");
  if (campo) { campo.value = ""; campo.focus(); }
  $("#resultado-bipe").innerHTML = '<div class="achado"><span class="ok">Etiqueta do pedido ' + esc(e.chave) + " enviada para impressão.</span></div>";
  desenharExpedicao();
}

/* ------------------------------------------------------------------ Produtos */
// Uma linha por SKU do Sankhya (saldo e preço de loja) e a presença em cada canal de venda.
// Os cartões do topo são os filtros. Clicar na linha abre o detalhe por canal.
const TXT_SIT = { ativo: "Ativo", pausado: "Pausado", sem_estoque: "Sem estoque", inativo: "Inativo", nao_anunciado: "Não anunciado" };
const prod = { dados: null, filtro: "todos", busca: "", limite: 300 };
const temDiv = (p, campo) => p.canais.ml.anuncios.some((a) => a[campo]);
const FILTROS_PROD = [
  ["todos", "Todos os SKUs", () => true],
  ["saldo", "Com saldo no Sankhya", (p) => p.disp > 0],
  ["ml", "Ativos no Mercado Livre", (p) => p.canais.ml.situacao === "ativo"],
  ["fora", "Com saldo e fora dos canais", (p) => p.disp > 0 && p.canais.ml.situacao !== "ativo"],
  ["pausados", "Pausados por vocês", (p) => p.canais.ml.situacao === "pausado"],
  ["ajustar", "Estoque ou preço a ajustar", (p) => temDiv(p, "div_qtd") || temDiv(p, "div_preco")],
];

async function renderProdutos() {
  prod.dados = await api("/api/produtos");
  desenharProdutos();
}

function seloSituacao(canal, s) {
  if (!canal.integrado) return '<span class="canal off" title="' + esc(canal.nome) + ': integração em breve">' + esc(canal.nome) + "</span>";
  const n = s.anuncios.length;
  return '<span class="canal ' + esc(s.situacao) + '" title="' + esc(canal.nome + ": " + TXT_SIT[s.situacao] + (n ? " · " + n + " anúncio(s)" : "")) + '"><span class="ponto"></span>' +
    esc(canal.nome) + " · <b>" + esc(TXT_SIT[s.situacao]) + "</b>" + (n > 1 ? " ×" + n : "") + "</span>";
}

function desenharProdutos() {
  const d = prod.dados;
  const lista = d.produtos;
  const b = prod.busca.trim().toUpperCase();
  const f = (FILTROS_PROD.find(([k]) => k === prod.filtro) || FILTROS_PROD[0])[2];
  const filtrados = lista.filter(f).filter((p) => !b || p.sku.includes(b) || String(p.produto || "").toUpperCase().includes(b) ||
    p.canais.ml.anuncios.some((a) => a.item_id.includes(b)));
  const linhas = filtrados.map((p) => {
    const avisos = (temDiv(p, "div_qtd") ? '<span class="tag warn">Estoque a ajustar</span>' : "") + (temDiv(p, "div_preco") ? '<span class="tag warn">Preço a ajustar</span>' : "");
    const ult = p.canais.ml.anuncios.filter((a) => a.acao_em).sort((x, y) => y.acao_em - x.acao_em)[0];
    return '<tr class="clicavel" data-sku="' + esc(p.sku) + '"><td><b>' + esc(p.sku) + '</b></td><td class="prod-nome">' + esc(p.produto || "—") + "</td>" +
      '<td class="n">' + (p.disp == null ? '<span class="mut">Sem cadastro</span>' : esc(p.disp)) + '</td><td class="n">' + brl(p.preco_loja) + "</td>" +
      '<td><div class="canais-linha">' + d.canais.map((c) => seloSituacao(c, p.canais[c.id] || { situacao: "nao_anunciado", anuncios: [] })).join("") + avisos + "</div></td>" +
      '<td class="mut" title="' + esc(ult ? ult.ultima_acao : "") + '">' + (ult ? esc(cap(haQuanto(ult.acao_em))) : "—") + "</td></tr>";
  }).join("");
  $("#conteudo").innerHTML =
    '<div class="cards">' + FILTROS_PROD.map(([k, t, fn]) => {
      const n = lista.filter(fn).length;
      return '<button type="button" class="card clicavel' + (prod.filtro === k ? " ativo" : "") + ((k === "fora" || k === "ajustar") && n ? " alerta" : "") +
        '" data-filtro-prod="' + k + '" aria-pressed="' + (prod.filtro === k) + '"><b>' + n.toLocaleString("pt-BR") + "</b><span>" + esc(t) + "</span></button>";
    }).join("") + "</div>" +
    '<div class="barra"><input id="busca-prod" type="search" placeholder="SKU, produto ou MLB" value="' + esc(prod.busca) + '" aria-label="Buscar produto">' +
    '<span class="espaco"></span><span class="atualizado">Sankhya lido ' + esc(haQuanto(d.erpEm)) + "</span>" +
    '<button id="rodar-estoque" type="button">Sincronizar agora</button></div>' +
    '<div class="painel"><table><thead><tr><th>SKU</th><th>Produto</th><th class="n">Saldo</th><th class="n">Preço loja</th><th>Canais</th><th>Última ação</th></tr></thead><tbody id="tb-prod">' +
    (linhas || '<tr><td colspan="6" class="vazio">Nenhum SKU neste filtro.</td></tr>') + "</tbody></table></div>";
  $("#busca-prod").oninput = (e) => {
    prod.busca = e.target.value; prod.limite = 300;
    clearTimeout(desenharProdutos.t);
    desenharProdutos.t = setTimeout(() => { desenharProdutos(); const x = $("#busca-prod"); x.focus(); x.setSelectionRange(x.value.length, x.value.length); }, 250);
  };
  $("#rodar-estoque").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "Sincronizando…";
    try { await post("/api/estoque/rodar"); avisar("Estoque e preço sincronizados."); await renderProdutos(); }
    catch (x) { erro(x); e.target.disabled = false; e.target.textContent = "Sincronizar agora"; }
  };
}

function situacaoAnuncio(a) {
  const s = String(a.sub_status);
  if (s.includes("paused_by_seller")) return '<span class="tag warn">Pausado por vocês</span>';
  if (a.status === "active") return '<span class="tag ok">Ativo</span>';
  if (s.includes("out_of_stock")) return '<span class="tag">Sem estoque</span>';
  return '<span class="tag">' + esc(cap(a.status)) + "</span>";
}

function abrirProduto(sku) {
  const p = prod.dados && prod.dados.produtos.find((x) => x.sku === sku);
  if (!p) return;
  const blocos = prod.dados.canais.map((c) => {
    const s = p.canais[c.id];
    let corpo;
    if (!c.integrado) corpo = '<p class="mut">Integração em breve: a loja da Skyline entra aqui.</p>';
    else if (!s.anuncios.length) {
      corpo = '<p class="mut">Sem anúncio no ' + esc(c.nome) + "." + (p.disp > 0 && permitido("publicacao") ? " Tem saldo, dá para publicar.</p>" +
        '<p><button type="button" class="primario" data-ir-publicar="' + esc(p.sku) + '">Abrir em Publicar anúncios</button></p>' : "</p>");
    } else {
      corpo = '<div class="tabela"><table><thead><tr><th>Anúncio</th><th>Tipo</th><th>Situação</th><th>Flex</th><th class="n">Estoque</th><th class="n">Preço</th><th class="n">Preço alvo</th></tr></thead><tbody>' +
        s.anuncios.map((a) => '<tr><td><a href="https://produto.mercadolivre.com.br/' + esc(a.item_id.replace(/^MLB/, "MLB-")) + '" target="_blank" rel="noopener">' + esc(a.item_id) + "</a></td>" +
          "<td>" + esc(TIPOS[a.listing_type] || a.listing_type) + "</td><td>" + situacaoAnuncio(a) + "</td><td>" + (a.flex === 1 ? '<span class="tag ok">Sim</span>' : a.flex === 0 ? "Não" : "—") +
          '</td><td class="n' + (a.div_qtd ? " warn" : "") + '">' + esc(a.qtd_ml) +
          '</td><td class="n' + (a.div_preco ? " warn" : "") + '">' + brl(a.preco_ml) + '</td><td class="n">' + brl(a.preco_alvo) + "</td></tr>" +
          (a.ultima_acao ? '<tr><td colspan="7" class="mut">Última ação ' + esc(dt(a.acao_em)) + ": " + esc(cap(a.ultima_acao)) + "</td></tr>" : "")).join("") +
        "</tbody></table></div>";
    }
    return '<div class="bloco-canal"><div class="cab"><b>' + esc(c.nome) + "</b>" + (c.integrado ? seloSituacao(c, s) : '<span class="canal off">Em breve</span>') + "</div>" + corpo + "</div>";
  }).join("");
  $("#gaveta-titulo").textContent = p.sku;
  $("#gaveta-corpo").innerHTML =
    '<dl class="dados"><dt>Produto</dt><dd>' + esc(p.produto || "—") + "</dd>" +
    "<dt>Saldo no Sankhya</dt><dd>" + (p.disp == null ? "SKU não encontrado no cadastro" : esc(p.disp)) + "</dd>" +
    "<dt>Preço de loja</dt><dd>" + brl(p.preco_loja) + ' <span class="mut">(tabela 0)</span></dd>' +
    "<dt>Cadastro</dt><dd>" + (p.ativo_erp == null ? "—" : p.ativo_erp ? "Ativo" : '<span class="warn">Inativo no Sankhya</span>') + "</dd></dl>" +
    '<p class="secao-gaveta">Canais de venda</p>' + blocos;
  $("#gaveta").hidden = false;
}

/* ------------------------------------------------------------------ Precificação */
const TIPOS = { gold_special: "Clássico", gold_pro: "Premium" };

async function renderPrecificacao() {
  // Precificação mora dentro do canal (menu Mercado Livre); a Nuvemshop terá a sua.
  const d = await api("/api/reguas");
  const r = d.reguas;
  const cartao = (tipo) =>
    '<div class="regua"><h4>' + esc(TIPOS[tipo] || tipo) + "</h4>" +
    '<label>Multiplicador sobre o preço de loja<input type="number" step="0.0001" min="' + d.limites.fatorMin + '" max="' + d.limites.fatorMax + '" data-tipo="' + tipo + '" data-campo="fator" value="' + esc(r[tipo].fator) + '"></label>' +
    '<label>Acréscimo fixo (R$)<input type="number" step="0.01" min="' + d.limites.somaMin + '" max="' + d.limites.somaMax + '" data-tipo="' + tipo + '" data-campo="soma" value="' + esc(r[tipo].soma) + '"></label>' +
    '<div class="formula" id="ex-' + tipo + '"></div></div>';
  const hist = (d.historico || []).map((h) => "<tr><td>" + esc(dt(h.em)) + "</td><td>" + esc(h.responsavel) + "</td><td>" +
    Object.keys(TIPOS).map((t) => esc(TIPOS[t]) + ": ×" + esc(h.reguas[t].fator) + " + " + brl(h.reguas[t].soma)).join("<br>") + "</td><td>" + esc(h.motivo || "") + "</td></tr>").join("");
  $("#conteudo").innerHTML =
    '<div class="painel"><h3>Réguas vigentes</h3><p class="mut texto-painel">Preço no ML = preço de loja (tabela 0 do Sankhya) × multiplicador + acréscimo. ' +
    "Vale para os anúncios com saldo. Mudanças acima de 25% num anúncio não são aplicadas automaticamente. Depois de salvar, o ML é atualizado em até ~2 min (15 anúncios por rodada).</p>" +
    '<div class="reguas">' + Object.keys(TIPOS).map(cartao).join("") + "</div>" +
    '<div class="form-linha"><span class="mut">Fica registrado com o seu login (' + esc(eu ? eu.email : "") + ").</span>" +
    '<label class="motivo">Motivo<input id="motivo" maxlength="200" placeholder="Ex.: campanha, custo de frete"></label>' +
    '<button type="button" id="simular">Simular impacto</button><button type="button" id="salvar" class="primario">Salvar régua</button></div>' +
    '<div id="simulacao"></div></div>' +
    '<div class="painel"><h3>Histórico de alterações</h3><table><thead><tr><th>Quando</th><th>Quem</th><th>Régua</th><th>Motivo</th></tr></thead><tbody>' +
    (hist || '<tr><td colspan="4" class="mut">Nenhuma alteração ainda — vigente é a padrão (Clássico ×1,1236 + R$ 70).</td></tr>') + "</tbody></table></div>";
  const ler = () => {
    const out = {};
    for (const t of Object.keys(TIPOS)) out[t] = { fator: Number($('input[data-tipo="' + t + '"][data-campo="fator"]').value), soma: Number($('input[data-tipo="' + t + '"][data-campo="soma"]').value) };
    return out;
  };
  const exemplo = () => { const g = ler(); for (const t of Object.keys(TIPOS)) $("#ex-" + t).textContent = "Ex.: loja R$ 1.000,00 → ML " + brl(1000 * g[t].fator + g[t].soma); };
  $$(".regua input").forEach((i) => { i.oninput = exemplo; });
  exemplo();
  $("#simular").onclick = async () => {
    const s = await post("/api/reguas/simular", { reguas: ler() });
    $("#simulacao").innerHTML = '<div class="cards">' + [["Anúncios com saldo", s.avaliados], ["Mudam de preço", s.mudam], ["Sobem", s.sobem], ["Descem", s.descem],
      ["Travados (>25%)", s.bloqueados], ["Variação média", s.variacaoMedia + "%"]].map(([t, v]) => '<div class="card"><b>' + esc(v) + "</b><span>" + t + "</span></div>").join("") + "</div>" +
      (s.exemplos.length ? "<table><thead><tr><th>Anúncio</th><th>SKU</th><th class='n'>Hoje</th><th class='n'>Com a nova régua</th></tr></thead><tbody>" +
        s.exemplos.map((x) => "<tr><td>" + esc(x.item_id) + "</td><td>" + esc(x.sku) + "</td><td class='n'>" + brl(x.de) + "</td><td class='n'>" + brl(x.para) + "</td></tr>").join("") + "</tbody></table>" : "");
  };
  $("#salvar").onclick = async (e) => {
    const s = await post("/api/reguas/simular", { reguas: ler() });
    if (!confirm("Salvar a régua? " + s.mudam + " anúncio(s) mudam de preço no ML (" + s.sobem + " sobem, " + s.descem + " descem).")) return;
    e.target.disabled = true;
    await post("/api/reguas", { reguas: ler(), motivo: $("#motivo").value.trim() });
    navegar();
  };
}

/* ------------------------------------------------------------------ Integração */
async function renderIntegracao(sub) {
  if (sub === "logs") return renderLogs();
  if (sub === "eventos") return renderEventos();
  if (sub === "nfs") return renderNfs();
  return renderArvore();
}

async function renderLogs() {
  const d = await api("/api/log");
  const nivel = { erro: "err", aviso: "warn", info: "ok" };
  $("#conteudo").innerHTML = '<div class="barra"><input id="busca-log" type="search" placeholder="Filtrar mensagens" aria-label="Filtrar logs"><select id="nivel-log" aria-label="Nível">' +
    '<option value="">Todos os níveis</option><option value="erro">Erro</option><option value="aviso">Aviso</option><option value="info">Info</option></select></div>' +
    '<div class="painel"><table><thead><tr><th>Quando</th><th>Nível</th><th>Pedido</th><th>Mensagem</th></tr></thead><tbody id="tb-log"></tbody></table></div>';
  const desenhar = () => {
    const q = $("#busca-log").value.toLowerCase(), n = $("#nivel-log").value;
    $("#tb-log").innerHTML = d.log.filter((l) => (!n || l.nivel === n) && (!q || String(l.msg).toLowerCase().includes(q) || String(l.chave || "").includes(q)))
      .map((l) => "<tr><td>" + esc(dt(l.em)) + '</td><td><span class="tag ' + (nivel[l.nivel] || "") + '">' + esc(cap(l.nivel)) + "</span></td><td>" + esc(l.chave || "—") + "</td><td>" + esc(cap(l.msg)) + "</td></tr>").join("");
  };
  $("#busca-log").oninput = desenhar; $("#nivel-log").onchange = desenhar; desenhar();
}

async function renderEventos() {
  const d = await api("/api/eventos");
  $("#conteudo").innerHTML = '<div class="painel"><table><thead><tr><th>ID</th><th>Recebido</th><th>Tópico</th><th>Recurso</th><th>Status</th><th class="n">Tent.</th><th>Erro</th><th></th></tr></thead><tbody>' +
    d.eventos.map((e) => "<tr><td>" + e.id + "</td><td>" + esc(dt(e.recebido_em)) + "</td><td>" + esc(e.topic) + "</td><td>" + esc(e.resource) +
      '</td><td><span class="tag ' + ({ ok: "ok", erro: "err", pendente: "warn" }[e.status] || "") + '">' + esc(cap(e.status)) + '</span></td><td class="n">' + e.tentativas +
      '</td><td class="mut">' + esc(cap(e.erro || "")) + "</td><td>" + (e.status === "erro" ? '<button type="button" data-reabrir="' + e.id + '">Reabrir</button>' : "") + "</td></tr>").join("") + "</tbody></table></div>";
}

const NOME_MODO = { automatico: "Automático", manual: "Manual", sombra: "Sombra" };
const NOME_NF = { enviado: "Enviado", ja_no_ml: "Já no ML", pronto: "Pronto", aguardando_ml: "Aguardando ML", erro: "Erro", divergente: "Divergente", cancelado: "Cancelado", nao_se_aplica: "Não se aplica" };
const NOME_LOGISTICA = { xd_drop_off: "Agência (xd_drop_off)", self_service: "Flex", drop_off: "Agência", cross_docking: "Coleta", fulfillment: "Full" };

async function renderNfs() {
  const d = await api("/api/nfs");
  const cor = { enviado: "ok", ja_no_ml: "ok", pronto: "info", aguardando_ml: "warn", erro: "err", divergente: "err", cancelado: "", nao_se_aplica: "" };
  $("#conteudo").innerHTML = '<div class="barra"><span class="mut">Envio do XML: modo <b>' + esc(NOME_MODO[d.xmlModo] || cap(d.xmlModo)) + '</b></span><span class="espaco"></span><button type="button" id="varrer">Varrer NFs faturadas agora</button></div>' +
    '<div class="painel"><table><thead><tr><th>Atualizado</th><th>Pedido ML</th><th>NF</th><th>Envio</th><th>Logística</th><th>Status</th><th>Detalhe</th><th></th></tr></thead><tbody>' +
    d.nfs.map((n) => "<tr><td>" + esc(dt(n.atualizado_em)) + "</td><td>" + esc(n.chave) + "</td><td>" + esc(nfDaChave(n.fiscal_key) || "—") + " <span class='mut'>(" + esc(n.nunota_nf) + ")</span></td><td>" +
      esc(n.shipment_id || "—") + "</td><td>" + esc(NOME_LOGISTICA[n.logistica] || n.logistica || "—") + '</td><td><span class="tag ' + (cor[n.status] || "") + '">' + esc(NOME_NF[n.status] || cap(n.status)) + '</span></td><td class="mut">' + esc(cap(n.detalhe || "")) +
      "</td><td>" + (n.status === "pronto" || n.status === "erro" ? '<button type="button" data-acao="xml" data-chave="' + esc(n.chave) + '">Enviar XML</button>' : "") + "</td></tr>").join("") + "</tbody></table></div>";
  $("#varrer").onclick = async (e) => { e.target.disabled = true; e.target.textContent = "Varrendo…"; await post("/api/nfs/varrer"); navegar(); };
}

/* ------------------------------------------------------------------ Meu perfil */
// A pessoa muda o próprio nome e e-mail (função e acesso seguem com o administrador).
// Trocar o e-mail muda o login: pede a senha atual, conferida direto no Supabase.
async function renderPerfil() {
  const u = await api("/api/eu");
  $("#conteudo").innerHTML =
    '<div class="perfil">' +
    '<div class="painel"><div class="perfil-topo"><span class="avatar grande" aria-hidden="true">' + esc(iniciais(u.nome || u.email)) + "</span>" +
      "<div><b>" + esc(u.nome) + '</b><div class="mut">' + esc(u.email) + "</div><div class=\"mut\">" + esc((u.funcao || "") + " · Skyline") + "</div></div></div></div>" +
    '<div class="painel"><h3>Nome</h3><form id="perfil-nome" class="form-perfil">' +
      '<label>Como você aparece no SkyHub<input name="nome" maxlength="80" required autocomplete="name" value="' + esc(u.nome) + '"></label>' +
      '<div class="acoes"><button class="primario" type="submit">Salvar nome</button></div></form></div>' +
    '<div class="painel"><h3>E-mail de acesso</h3><form id="perfil-email" class="form-perfil" autocomplete="off">' +
      '<p class="dica">É o e-mail que você usa para entrar. Depois de trocar, o login passa a ser com o novo.</p>' +
      '<label>Novo e-mail<input name="email" type="email" required maxlength="254" autocomplete="off"></label>' +
      '<label>Repita o novo e-mail<input name="email2" type="email" required maxlength="254" autocomplete="off"></label>' +
      '<label>Senha atual<input name="senha" type="password" required autocomplete="current-password"></label>' +
      '<div class="acoes"><button class="primario" type="submit">Trocar e-mail</button></div></form></div>' +
    '<div class="painel"><h3>Senha</h3><div class="corpo-painel"><p class="dica">Pelo menos 8 caracteres, com letras e números.</p>' +
      '<div class="acoes"><button type="button" id="trocar-senha">Trocar senha</button></div></div></div>' +
    "</div>";

  $("#perfil-nome").onsubmit = async (ev) => {
    ev.preventDefault();
    const b = ev.target.querySelector("button");
    b.disabled = true;
    try {
      const r = await api("/api/eu", { method: "PUT", body: JSON.stringify({ nome: ev.target.nome.value }) });
      eu.nome = r.nome;
      $("#usuario-nome").textContent = r.nome;
      $("#usuario-avatar").textContent = iniciais(r.nome);
      avisar("Nome salvo.");
      await renderPerfil();
    } catch (e) { erro(e); } finally { b.disabled = false; }
  };

  $("#perfil-email").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const email = f.email.value.trim().toLowerCase();
    limparErro();
    if (email !== f.email2.value.trim().toLowerCase()) return erro("Os dois e-mails não são iguais.");
    if (email === String(u.email).toLowerCase()) return erro("Esse já é o seu e-mail.");
    const b = f.querySelector("button");
    b.disabled = true; b.textContent = "Conferindo a senha…";
    try {
      const falha = await skyAuth.confirmarSenha(f.senha.value);
      f.senha.value = "";
      if (falha) return erro(falha);
      b.textContent = "Trocando…";
      const r = await api("/api/eu", { method: "PUT", body: JSON.stringify({ email }) });
      await skyAuth.renovar(); // sessão nova já com o e-mail novo
      eu.email = r.email;
      avisar("E-mail alterado. No próximo login, entre com " + r.email + ".");
      await renderPerfil();
    } catch (e) { erro(e); } finally { b.disabled = false; b.textContent = "Trocar e-mail"; }
  };
}

/** Menu do cartão do usuário (abre para cima). */
function menuUsuario(abrir) {
  const m = $("#menu-usuario");
  const aberto = abrir === undefined ? m.hidden : abrir;
  m.hidden = !aberto;
  $("#abrir-usuario").setAttribute("aria-expanded", String(aberto));
  $("#usuario").classList.toggle("aberto", aberto);
}
$("#abrir-usuario").addEventListener("click", (ev) => { ev.stopPropagation(); menuUsuario(); });
document.addEventListener("click", (ev) => { if (!ev.target.closest("#usuario")) menuUsuario(false); });
$("#menu-usuario").addEventListener("click", () => menuUsuario(false));
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") menuUsuario(false); });

/* ------------------------------------------------------------------ Integrações: árvore */
// Sankhya (ERP) em cima, SkyHub no meio e os canais embaixo. A cor da linha é a saúde da ligação.
const TXT_SAUDE = { ok: "Operando", warn: "Atenção", err: "Sem resposta", off: "Em breve" };

function noArvore({ logo, marca, titulo, sub, saude, det, extra, classe }) {
  return '<div class="no-arvore ' + (classe || "") + " saude-" + saude + '">' +
    (logo ? '<img src="' + logo + '" alt="' + esc(titulo) + '"' + (marca ? ' class="' + marca + '"' : "") + ">" : '<span class="skyhub-marca">' + esc(titulo) + "</span>") +
    (sub ? '<span class="no-sub">' + esc(sub) + "</span>" : "") +
    '<span class="estado"><span class="ponto ' + (saude === "off" ? "" : saude) + '"></span>' + TXT_SAUDE[saude] + "</span>" +
    (det ? '<span class="det">' + det + "</span>" : "") + (extra || "") + "</div>";
}
const metrica = (valor, rotulo, dica) => '<div class="metrica"><b>' + esc(cap(valor)) + "</b><span>" + esc(cap(rotulo)) + (dica ? ' <span class="mut">· ' + esc(cap(dica)) + "</span>" : "") + "</span></div>";

async function renderArvore() {
  const s = await api("/api/integracao");
  const agora = s.agora, h = s.hoje;
  const saudeMl = !s.ml.tokenOk ? "err" : s.ml.eventosComErro ? "warn" : "ok";
  const saudeHub = !s.skyhub.ultimaRodada || agora - s.skyhub.ultimaRodada > 6 * 60_000 ? "err" : s.skyhub.rodadaAbortada ? "warn" : "ok";
  const saudeSk = !s.sankhya.ultimaLeitura || agora - s.sankhya.ultimaLeitura > 6 * 60_000 ? "err" : "ok";
  const canais = [
    {
      saude: saudeMl,
      html: noArvore({
        logo: "/logos/mercadolivre.webp", marca: "logo-claro", titulo: "Mercado Livre", saude: saudeMl,
        det: "Token " + (s.ml.tokenOk ? "válido até " + esc(hora(s.ml.expiraEm)) : "INVÁLIDO") + " · Último aviso " + esc(haQuanto(s.ml.ultimoEvento)) +
          (s.ml.eventosComErro ? '<br><a href="#integracao/eventos">' + esc(s.ml.eventosComErro) + " evento(s) com erro</a>" : ""),
        extra: '<div class="metricas">' + metrica(h.eventosRecebidos, "Vendas recebidas hoje", "Webhook") + metrica(h.xmlEnviados, "XML de NF enviados", "Libera a etiqueta") +
          metrica(h.ajustesAnuncio, "Estoque e preço ajustados", h.falhasAnuncio ? h.falhasAnuncio + " falha(s)" : "A cada 2 min") + metrica(h.etiquetasBaixadas, "Etiquetas baixadas", "PDF 10x15") + "</div>",
      }),
    },
    { saude: "off", html: noArvore({ titulo: "Nuvemshop", sub: "Loja da Skyline", saude: "off", classe: "breve", det: "Próxima integração" }) },
  ];
  $("#conteudo").innerHTML =
    '<div class="painel"><div class="arvore">' +
    noArvore({ logo: "/logos/sankhya.svg", marca: "logo-escuro", titulo: "Sankhya", sub: "ERP · Fonte de estoque, preço e fiscal", saude: saudeSk,
      det: "Última leitura " + esc(haQuanto(s.sankhya.ultimaLeitura)) + (s.sankhya.ultimoErro ? " · Último erro " + esc(haQuanto(s.sankhya.ultimoErro.em)) : "") }) +
    '<div class="tronco saude-' + saudeSk + '"><div class="rotulos">' +
      '<span class="rotulo">' + metrica(h.pedidosGravados, "Pedidos gravados hoje", "Parceiro + pedido 1090") + "</span>" +
      '<span class="rotulo">' + metrica(haQuanto(s.sankhya.ultimaLeitura), "Leitura de estoque e preço", "Tabela 0 e TGFEST") + "</span></div></div>" +
    noArvore({ titulo: "SkyHub", sub: "Integração", saude: saudeHub, classe: "hub",
      det: "Última rodada " + esc(haQuanto(s.skyhub.ultimaRodada)) + (s.skyhub.rodadaAbortada ? ' · <span class="warn">Abortada: ' + esc(s.skyhub.rodadaAbortada) + "</span>" : "") +
        "<br>" + esc(s.skyhub.eventosPendentes) + " evento(s) na fila · " + (h.errosLog ? '<a href="#integracao/logs">' + esc(h.errosLog) + " erro(s) hoje</a>" : "0 erros hoje") }) +
    '<div class="galhos' + (canais.length === 1 ? " um" : "") + '">' + canais.map((c) => '<div class="galho saude-' + c.saude + '">' + c.html + "</div>").join("") + "</div>" +
    "</div></div>" +
    '<div class="painel"><h3>Modos de operação</h3><table><tbody>' +
    [["Pedidos → Sankhya", s.modos.pedidos], ["XML da NF → ML", s.modos.xml], ["Cancelamento no Sankhya", s.modos.cancelamento], ["Estoque → ML", s.modos.estoque], ["Preço → ML", s.modos.preco]]
      .map(([n, m]) => "<tr><td>" + esc(n) + '</td><td><span class="tag ' + (m === "automatico" ? "ok" : m === "manual" ? "warn" : "") + '">' + esc(NOME_MODO[m] || cap(m)) + "</span></td></tr>").join("") +
    "</tbody></table></div>";
}

/* ------------------------------------------------------------------ eventos globais */
document.addEventListener("click", async (ev) => {
  const linhaProd = ev.target.closest("tr[data-sku]");
  if (linhaProd && !ev.target.closest("a")) return abrirProduto(linhaProd.dataset.sku);
  const b = ev.target.closest("button, [data-ped]");
  if (!b) return;
  try {
    if (b.dataset.filtroProd) { prod.filtro = b.dataset.filtroProd; prod.limite = 300; return desenharProdutos(); }
    if (b.dataset.irPublicar) { pub.busca = b.dataset.irPublicar; pub.filtro = "todos"; $("#gaveta").hidden = true; location.hash = "#publicacao"; return; }
    if (b.id === "sair") { eu = null; $("#usuario").hidden = true; return skyAuth.sair(); }
    if (b.id === "trocar-senha") return skyAuth.trocarSenha();
    if (b.id === "fechar-gaveta") { $("#gaveta").hidden = true; return; }
    if (b.dataset.ped) return abrirPedido(b.dataset.ped);
    if (b.dataset.imprimir) return imprimirEtiquetas(b.dataset.imprimir);
    if (b.id === "fechar-cancelado" || b.id === "ok-cancelado") return fecharCancelado();
    if (b.dataset.exp) {
      const e = expedicao.lista.find((x) => x.shipment_id === b.dataset.exp);
      // Botão da tabela não passou pelo bipe: confere o cancelamento antes de imprimir.
      if (e && (await checarCancelamento(e.shipment_id))) return imprimirExpedicao(e);
      return;
    }
    if (b.dataset.reabrir) { await post("/api/eventos/" + b.dataset.reabrir + "/reabrir"); return navegar(); }
    if (b.dataset.acao === "gravar") {
      if (!confirm("Gravar este pedido no Sankhya? Cria o parceiro se for comprador novo, inclui e confirma o pedido 1090.")) return;
      b.disabled = true;
      const d = await post("/api/pedidos/" + b.dataset.order + "/gravar");
      avisar("Gravado no Sankhya: pedido " + (d.pedido.nunota ?? "?"));
      $("#gaveta").hidden = true; return navegar();
    }
    if (b.dataset.acao === "xml") {
      if (!confirm("Enviar ao Mercado Livre o XML da NF deste pedido? Isso libera a etiqueta.")) return;
      b.disabled = true;
      const d = await post("/api/nfs/" + b.dataset.chave + "/enviar");
      avisar("XML: " + d.status + (d.nf && d.nf.detalhe ? " — " + d.nf.detalhe : ""));
      $("#gaveta").hidden = true; return navegar();
    }
    if (b.dataset.acao === "reprocessar") {
      b.disabled = true;
      await post("/api/pedidos/" + b.dataset.order + "/processar");
      $("#gaveta").hidden = true; return navegar();
    }
  } catch (e) { erro(e); b.disabled = false; }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#cancelado").hidden) return fecharCancelado();
  $("#gaveta").hidden = true;
});
$("#gaveta").addEventListener("click", (e) => { if (e.target.id === "gaveta") $("#gaveta").hidden = true; });
window.addEventListener("hashchange", navegar);
// Ao voltar da janela de impressão (ou de outra janela), o cursor volta para o bipe.
window.addEventListener("focus", () => { if (rota().mod === "expedicao") setTimeout(focarBipe, 50); });
window.addEventListener("afterprint", () => setTimeout(focarBipe, 50));
// Atualização automática a cada minuto. Não mexe na tela enquanto alguém está usando:
// gaveta ou alerta abertos, busca digitada, impressão em lote em andamento.
let autoOcupado = false;
setInterval(async () => {
  if (!eu || document.hidden || autoOcupado) return;
  if (!$("#gaveta").hidden || !$("#cancelado").hidden) return;
  const { mod } = rota();
  autoOcupado = true;
  try {
    if (mod === "expedicao") {
      if ($("#imprimir-sel") && /Conferindo/.test($("#imprimir-sel").textContent)) return;
      await recarregarExpedicao();
      focarBipe();
    } else if (mod === "pedidos") {
      const ativo = document.activeElement;
      if (ativo && (ativo.id === "busca-ped" || ativo.id === "dias")) return;
      await renderPedidos();
    } else {
      atualizarContagemExpedicao();
    }
  } catch { /* falha passageira: tenta no próximo minuto */ } finally { autoOcupado = false; }
}, AUTO_MS);

skyAuth.iniciar(entrarNoPainel);
