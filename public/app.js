// SkyHub — painel (módulos Pedidos, Produtos, Precificação e Integração).
// JS puro, sem build. Dados de /api/* com o token guardado só no sessionStorage.
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const brl = (v) => (v == null || v === "" ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const dt = (ms) => (ms ? new Date(ms).toLocaleString("pt-BR") : "—");
const dtIso = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR") : "—");
const hora = (ms) => (ms ? new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—");
const nfDaChave = (k) => (k && k.length === 44 ? String(Number(k.slice(25, 34))) : null);
const haQuanto = (ms) => {
  if (!ms) return "nunca";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "há " + s + " s";
  if (s < 3600) return "há " + Math.round(s / 60) + " min";
  if (s < 86400) return "há " + Math.round(s / 3600) + " h";
  return "há " + Math.round(s / 86400) + " d";
};

let token = "";
try { token = sessionStorage.getItem("skyhub_tk") || ""; } catch { /* sessionStorage indisponível */ }
const estado = { fluxoDias: 7, busca: "", filtroProd: "todos" };

async function api(caminho, opt = {}) {
  const r = await fetch(caminho, { ...opt, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
  if (r.status === 401) throw new Error("Token inválido ou ausente.");
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.erro || "Falha HTTP " + r.status);
  return d;
}
const post = (caminho, corpo) => api(caminho, { method: "POST", body: corpo ? JSON.stringify(corpo) : undefined });

function erro(e) { $("#msg").textContent = e && e.message ? e.message : String(e); }
function limparErro() { $("#msg").textContent = ""; }

/* ------------------------------------------------------------------ roteamento */
const MODULOS = {
  pedidos: { titulo: "Pedidos", render: renderPedidos },
  expedicao: { titulo: "Expedição", render: renderExpedicao },
  produtos: { titulo: "Produtos", render: renderProdutos },
  precificacao: { titulo: "Precificação", render: renderPrecificacao },
  integracao: { titulo: "Integração", render: renderIntegracao },
};

function rota() {
  const [mod, sub] = (location.hash.replace(/^#/, "") || "pedidos").split("/");
  const m = MODULOS[mod] ? mod : "pedidos";
  return { mod: m, sub: sub || (m === "integracao" ? "visao" : m === "expedicao" ? "imprimir" : "") };
}

async function navegar() {
  const { mod, sub } = rota();
  $$("nav a[data-mod]").forEach((a) => a.classList.toggle("ativo", a.dataset.mod === mod));
  $("#sub-integracao").classList.toggle("aberto", mod === "integracao");
  $$("#sub-integracao a").forEach((a) => a.classList.toggle("ativo", mod === "integracao" && a.dataset.sub === sub));
  $("#sub-expedicao").classList.toggle("aberto", mod === "expedicao");
  $$("#sub-expedicao a").forEach((a) => a.classList.toggle("ativo", mod === "expedicao" && a.dataset.sub === sub));
  const subtitulo = mod === "integracao" ? ({ visao: "Visão geral", nfs: "NF-e → ML", logs: "Logs", eventos: "Eventos" }[sub] || "")
    : mod === "expedicao" ? ({ imprimir: "Para imprimir", impressos: "Impressos", despachados: "Despachados" }[sub] || "")
    : mod === "precificacao" && sub === "ml" ? "Mercado Livre" : "";
  $("#titulo").textContent = MODULOS[mod].titulo + (subtitulo ? " · " + subtitulo : "");
  limparErro();
  if (!token) { $("#conteudo").innerHTML = '<p class="vazio">Informe o token de acesso para carregar.</p>'; return; }
  $("#conteudo").innerHTML = '<p class="vazio">Carregando…</p>';
  try { await MODULOS[mod].render(sub); } catch (e) { erro(e); $("#conteudo").innerHTML = ""; }
}

async function carregarModos() {
  try {
    const s = await api("/api/integracao");
    const nomes = { pedidos: "pedidos", xml: "XML", cancelamento: "cancelamento", estoque: "estoque", preco: "preço" };
    $("#modos").innerHTML = Object.entries(s.modos).map(([k, v]) =>
      '<span class="chip ' + (v === "automatico" ? "auto" : v === "manual" ? "manual" : "") + '" title="modo ' + esc(v) + '">' + esc(nomes[k] || k) + ": " + esc(v) + "</span>").join("");
  } catch { /* o erro aparece no módulo */ }
}

/* ------------------------------------------------------------------ Pedidos */
const FASE_INFO = {
  novo: { nome: "Recebido", desc: "Venda no ML, ainda fora do Sankhya" },
  erp: { nome: "No Sankhya", desc: "Pedido 1090, aguardando faturamento" },
  faturado: { nome: "Faturado", desc: "NF autorizada, XML ainda não aceito pelo ML" },
  nf_ml: { nome: "NF no ML", desc: "XML aceito, etiqueta liberada" },
  etiqueta: { nome: "Etiqueta impressa", desc: "Aguardando coleta" },
  enviado: { nome: "Enviado", desc: "Saiu para entrega" },
  atencao: { nome: "Atenção", desc: "Bloqueado, divergente ou com erro" },
  cancelado: { nome: "Cancelados", desc: "Cancelados no ML" },
};

async function renderPedidos() {
  const d = await api("/api/fluxo?dias=" + estado.fluxoDias);
  const busca = estado.busca.trim();
  const pedidos = busca ? d.pedidos.filter((p) => String(p.chave).includes(busca) || String(p.order_ids).includes(busca) || String(p.nunota ?? "").includes(busca)) : d.pedidos;
  const porFase = Object.fromEntries(d.fases.map((f) => [f, pedidos.filter((p) => p.fase === f)]));
  const barra = '<div class="barra">' +
    '<label for="dias" class="mut">Período</label><select id="dias">' +
    [1, 7, 15, 30].map((n) => '<option value="' + n + '"' + (n === estado.fluxoDias ? " selected" : "") + ">" + (n === 1 ? "últimas 24 h" : "últimos " + n + " dias") + "</option>").join("") +
    '</select><input id="busca-ped" type="search" placeholder="nº do ML ou NUNOTA" value="' + esc(estado.busca) + '" aria-label="Buscar pedido">' +
    '<span class="espaco"></span><button id="recarregar-ped" type="button">Atualizar</button></div>';
  const colunas = d.fases.map((f) => {
    const lista = porFase[f];
    const imprimiveis = lista.filter((p) => p.shipment_id && (p.envio_substatus === "ready_to_print" || p.envio_substatus === "printed"));
    const acaoColuna = (f === "nf_ml" && imprimiveis.length)
      ? '<button type="button" class="primario" data-imprimir="' + esc(imprimiveis.map((p) => p.shipment_id).join(",")) + '">Imprimir etiquetas (' + imprimiveis.length + ")</button>" : "";
    return '<div class="coluna ' + f + '"><div class="coluna-topo"><div class="t">' + esc(FASE_INFO[f].nome) + '<span class="qtd">' + lista.length + "</span></div>" +
      '<div class="desc">' + esc(FASE_INFO[f].desc) + "</div>" + acaoColuna + '</div><div class="coluna-corpo">' +
      (lista.length ? lista.map(cartaoPedido).join("") : '<span class="mut" style="font-size:12px">nenhum</span>') + "</div></div>";
  }).join("");
  $("#conteudo").innerHTML = barra + '<div class="esteira">' + colunas + "</div>";
  $("#dias").onchange = (e) => { estado.fluxoDias = Number(e.target.value); navegar(); };
  $("#busca-ped").oninput = (e) => { estado.busca = e.target.value; clearTimeout(renderPedidos.t); renderPedidos.t = setTimeout(navegar, 300); };
  $("#recarregar-ped").onclick = navegar;
}

function cartaoPedido(p) {
  const tags = [];
  if (p.nunota) tags.push('<span class="tag">pedido ' + esc(p.nunota) + "</span>");
  const nf = nfDaChave(p.fiscal_key);
  if (nf) tags.push('<span class="tag info">NF ' + esc(nf) + "</span>");
  if (p.situacao === "aguardando_comissao") tags.push('<span class="tag warn">aguardando comissão</span>');
  if (p.situacao === "aguardando_pagamento") tags.push('<span class="tag warn">aguardando pagamento</span>');
  if (p.situacao === "pronto") tags.push('<span class="tag info">pronto p/ gravar</span>');
  if (p.gravacao === "erro") tags.push('<span class="tag err">erro na gravação</span>');
  if (p.nf_status === "erro" || p.nf_status === "divergente") tags.push('<span class="tag err">NF: ' + esc(p.nf_status) + "</span>");
  if (p.cancelamento) tags.push('<span class="tag ' + (/^cancelado/.test(p.cancelamento) ? "ok" : "warn") + '">' + esc(p.cancelamento.split(":")[0]) + "</span>");
  return '<button type="button" class="ped" data-ped="' + esc(p.chave) + '"><div class="l1"><span class="ch">…' + esc(String(p.chave).slice(-8)) + '</span><span class="vl">' + brl(p.total) + "</span></div>" +
    '<div class="l2">' + esc(dtIso(p.data_ml)) + (p.codparc ? " · parceiro " + esc(p.codparc) : "") + '</div><div class="l3">' + tags.join("") + "</div></button>";
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
    "<dt>Data no ML</dt><dd>" + esc(dtIso(p.data_ml)) + "</dd><dt>Status no ML</dt><dd>" + esc(p.status_ml) + "</dd>" +
    "<dt>Orders</dt><dd>" + esc(p.order_ids) + "</dd><dt>Total</dt><dd>" + brl(p.total) + "</dd>" +
    "<dt>Comissão ML</dt><dd>" + brl(p.comissao) + "</dd><dt>Frete cobrado</dt><dd>" + brl(p.frete) + "</dd>" +
    "<dt>Parceiro</dt><dd>" + esc(p.codparc ?? "novo") + "</dd><dt>Pedido Sankhya</dt><dd>" + esc(p.nunota ?? "—") + (p.gravacao ? " (" + esc(p.gravacao) + ")" : "") + "</dd>" +
    "<dt>NF</dt><dd>" + (nf ? esc(nf) + " · NUNOTA " + esc(fl.nunota_nf) : "—") + (fl.nf_status ? " · " + esc(fl.nf_status) : "") + "</dd>" +
    "<dt>Envio</dt><dd>" + esc(fl.shipment_id ?? "—") + (fl.envio_status ? " · " + esc(fl.envio_status) + "/" + esc(fl.envio_substatus || "-") : "") + "</dd>" +
    (p.cancelamento ? "<dt>Cancelamento</dt><dd>" + esc(p.cancelamento) + "</dd>" : "") +
    (a.bloqueio ? '<dt>Bloqueio</dt><dd class="err">' + esc(a.bloqueio) + "</dd>" : "") +
    (p.gravacao_erro ? '<dt>Erro</dt><dd class="err">' + esc(p.gravacao_erro) + "</dd>" : "") + "</dl>" +
    (a.alertas && a.alertas.length ? "<div><b>Alertas</b><pre>" + a.alertas.map(esc).join("<br>") + "</pre></div>" : "") +
    "<div><b>Itens</b><pre>" + esc(JSON.stringify(a.itens || [], null, 2)) + "</pre></div>" +
    '<details><summary>incluirNota montado</summary><pre>' + esc(p.nota_json ? JSON.stringify(JSON.parse(p.nota_json), null, 2) : "—") + "</pre></details>";
  $("#gaveta").hidden = false;
}

async function imprimirEtiquetas(ids) {
  const lista = ids.split(",").filter(Boolean);
  if (lista.length > 20) throw new Error("Máximo de 20 etiquetas por vez.");
  if (!confirm("Baixar " + lista.length + " etiqueta(s) 10x15? O ML marca os envios como impressos.")) return;
  const r = await fetch("/api/etiquetas/baixar?formato=pdf&ids=" + lista.join(","), { headers: { Authorization: "Bearer " + token } });
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
const expedicao = { lista: [], achado: null, ultimoBipe: "", sel: new Set(), fase: "imprimir", despachados: [] };
// Fases (submenus): Para imprimir → Impressos → Despachados (bipado na agência, visto no ML).
const FASE_EXP = {
  imprimir: (e) => e.substatus === "ready_to_print",
  impressos: (e) => e.substatus === "printed",
};

/** Números dos submenus da Expedição. Silencioso: falha aqui não atrapalha a tela. */
async function atualizarContagemExpedicao() {
  if (!token) return;
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
    (c.motivo ? "<br>" + esc(c.motivo) : "") + (c.envio_status ? "<br>Envio: " + esc(c.envio_status) : "");
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
  expedicao.fase = FASE_EXP[sub] || sub === "despachados" ? sub : "imprimir";
  const [d, desp] = await Promise.all([
    api("/api/etiquetas"),
    expedicao.fase === "despachados" ? api("/api/etiquetas?fase=despachados") : Promise.resolve({ etiquetas: [] }),
  ]);
  expedicao.lista = d.etiquetas; // o bipe procura em tudo que ainda dá para imprimir, qualquer que seja a aba
  expedicao.despachados = desp.etiquetas;
  atualizarContagemExpedicao();
  const prontas = d.etiquetas.filter((e) => e.substatus === "ready_to_print").length;
  $("#conteudo").innerHTML =
    '<div class="bipe"><label for="bipe">Bipar etiqueta</label><input id="bipe" inputmode="numeric" autocomplete="off" placeholder="leia o código do pedido">' +
    '<button type="button" id="limpar-bipe">Limpar</button><button type="button" id="atualizar-exp">Atualizar lista</button>' +
    '<span class="dica">Aceita nº do pedido do ML, nº do envio, chave ou número da NF. O 1º bipe localiza; bipar de novo (ou Enter) imprime.</span></div>' +
    '<div id="resultado-bipe"></div>' +
    '<div class="cards"><div class="card"><b>' + prontas + '</b><span>Para imprimir</span></div><div class="card"><b>' + (d.etiquetas.length - prontas) + '</b><span>Impressas, aguardando despacho</span></div></div>' +
    (expedicao.fase === "despachados" ? '<p class="dica">Despachados hoje: o ML registrou a entrada do pacote na agência ou coleta.</p>' : "") +
    '<div class="acoes-sel"' + (expedicao.fase === "despachados" ? " hidden" : "") + '><button type="button" class="primario" id="imprimir-sel" disabled>Imprimir selecionadas</button><span class="dica" id="info-sel"></span></div>' +
    '<div class="painel"><table><thead><tr><th class="sel">' + (expedicao.fase === "despachados" ? "" : '<input type="checkbox" id="sel-todas" aria-label="Selecionar todas as visíveis">') + '</th><th>Pedido ML</th><th>NF</th><th>Envio</th><th>Venda</th><th class="n">Total</th><th>Situação</th><th></th></tr></thead><tbody id="tb-exp"></tbody></table></div>';
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
    const visiveis = $$("#tb-exp input[data-sel]").map((c) => c.dataset.sel);
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
  $("#atualizar-exp").onclick = async (e) => { e.target.disabled = true; await post("/api/etiquetas/atualizar"); navegar(); };
}

function localizar(codigo) {
  limparErro();
  expedicao.ultimoBipe = codigo;
  const achados = expedicao.lista.filter((e) => casaBipe(e, codigo));
  expedicao.achado = achados.length === 1 ? achados[0] : null;
  const alvo = $("#resultado-bipe");
  if (achados.length === 1) {
    const e = achados[0];
    alvo.innerHTML = '<div class="achado"><div><div class="mut">Pedido ML</div><div class="grande">' + esc(e.chave) + "</div></div>" +
      '<div><div class="mut">NF</div><div class="grande">' + esc(nfDaChave(e.fiscal_key) || "—") + "</div></div>" +
      '<div><div class="mut">Situação</div><div>' + (e.substatus === "ready_to_print" ? '<span class="tag info">para imprimir</span>' : '<span class="tag ok">já impressa ' + esc(dt(e.impresso_em)) + "</span>") + "</div></div>" +
      '<button type="button" class="primario" id="imprimir-achado">' + (e.substatus === "printed" ? "Reimprimir" : "Imprimir") + " etiqueta (Enter)</button></div>";
    $("#imprimir-achado").onclick = () => imprimirExpedicao(e).catch(erro);
  } else {
    alvo.innerHTML = '<div class="nao-achado">' + (achados.length ? achados.length + " etiquetas batem com esse código — use o número do envio." :
      "Nenhuma etiqueta liberada para “" + esc(codigo) + "”. Confira se a NF já foi faturada e enviada ao ML, ou clique em Atualizar lista.") + "</div>";
  }
  desenharExpedicao();
}

function desenharExpedicao() {
  if (expedicao.fase === "despachados") return desenharDespachados();
  const focoId = expedicao.achado && expedicao.achado.shipment_id;
  // O bipe acha em qualquer fase imprimível; sem bipe, a tabela mostra só a aba atual.
  const linhas = focoId ? expedicao.lista.filter((e) => e.shipment_id === focoId) : expedicao.lista.filter(FASE_EXP[expedicao.fase]);
  $("#tb-exp").innerHTML = linhas.map((e) => '<tr class="' + (e.shipment_id === focoId ? "foco" : "") + (expedicao.sel.has(e.shipment_id) ? " sel" : "") + '">' +
    '<td class="sel"><input type="checkbox" data-sel="' + esc(e.shipment_id) + '"' + (expedicao.sel.has(e.shipment_id) ? " checked" : "") +
    ' aria-label="Selecionar pedido ' + esc(e.chave || e.shipment_id) + '"></td><td><b>' + esc(e.chave || "—") + "</b></td><td>" +
    esc(nfDaChave(e.fiscal_key) || "—") + "</td><td>" + esc(e.shipment_id) + "</td><td>" + esc(dtIso(e.data_ml)) + '</td><td class="n">' + brl(e.total) + "</td><td>" +
    (e.substatus === "ready_to_print" ? '<span class="tag info">para imprimir</span>' : '<span class="tag ok">já impressa</span>') +
    '</td><td><button type="button" data-exp="' + esc(e.shipment_id) + '">' + (e.substatus === "printed" ? "Reimprimir" : "Imprimir") + "</button></td></tr>").join("") ||
    '<tr><td colspan="8" class="mut">Nenhuma etiqueta liberada agora.</td></tr>';
  atualizarSelecao();
}

function desenharDespachados() {
  $("#tb-exp").innerHTML = expedicao.despachados.map((e) => "<tr><td></td><td><b>" + esc(e.chave || "—") + "</b></td><td>" + esc(nfDaChave(e.fiscal_key) || "—") +
    "</td><td>" + esc(e.shipment_id) + "</td><td>" + esc(dtIso(e.data_ml)) + '</td><td class="n">' + brl(e.total) + "</td><td>" +
    '<span class="tag ok">despachado ' + esc(dt(e.despachado_em)) + '</span> <span class="mut">' + esc([e.status, e.substatus].filter(Boolean).join(" / ")) + "</span></td><td></td></tr>").join("") ||
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
  const r = await fetch("/api/etiquetas/baixar?formato=pdf&ids=" + ids.map(encodeURIComponent).join(","), { headers: { Authorization: "Bearer " + token } });
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
async function renderProdutos() {
  const d = await api("/api/produtos");
  const lista = d.produtos;
  const divQtd = (p) => p.disp != null && !String(p.sub_status).includes("paused_by_seller") && p.disp !== p.qtd_ml;
  const divPreco = (p) => p.preco_alvo != null && p.disp > 0 && p.preco_ml != null && Math.abs(p.preco_alvo - p.preco_ml) >= 0.01;
  const c = {
    total: lista.length,
    ativos: lista.filter((p) => p.status === "active").length,
    semEstoque: lista.filter((p) => String(p.sub_status).includes("out_of_stock")).length,
    pausadosVendedor: lista.filter((p) => String(p.sub_status).includes("paused_by_seller")).length,
    divQtd: lista.filter(divQtd).length,
    divPreco: lista.filter(divPreco).length,
  };
  const b = estado.busca.trim().toUpperCase();
  let filtrados = lista.filter((p) => !b || String(p.sku).includes(b) || String(p.item_id).includes(b));
  if (estado.filtroProd === "saldo") filtrados = filtrados.filter((p) => p.disp > 0);
  if (estado.filtroProd === "divergentes") filtrados = filtrados.filter((p) => divQtd(p) || divPreco(p));
  if (estado.filtroProd === "pausados") filtrados = filtrados.filter((p) => String(p.sub_status).includes("paused_by_seller"));
  const statusTxt = (p) => String(p.sub_status).includes("paused_by_seller") ? '<span class="tag warn">pausado por vocês</span>'
    : p.status === "active" ? '<span class="tag ok">ativo</span>' : String(p.sub_status).includes("out_of_stock") ? '<span class="tag">sem estoque</span>' : '<span class="tag">' + esc(p.status) + "</span>";
  $("#conteudo").innerHTML =
    '<div class="cards">' + [["Anúncios", c.total], ["Ativos", c.ativos], ["Sem estoque", c.semEstoque], ["Pausados por vocês", c.pausadosVendedor],
      ["Estoque a ajustar", c.divQtd], ["Preço a ajustar", c.divPreco]].map(([t, v]) => '<div class="card"><b>' + v + "</b><span>" + t + "</span></div>").join("") + "</div>" +
    '<div class="barra"><input id="busca-prod" type="search" placeholder="SKU ou MLB" value="' + esc(estado.busca) + '" aria-label="Buscar produto">' +
    '<select id="filtro-prod" aria-label="Filtro">' + [["todos", "Todos"], ["saldo", "Com saldo no ERP"], ["divergentes", "A ajustar"], ["pausados", "Pausados por vocês"]]
      .map(([v, t]) => '<option value="' + v + '"' + (estado.filtroProd === v ? " selected" : "") + ">" + t + "</option>").join("") + "</select>" +
    '<span class="espaco"></span><span class="mut">ERP lido ' + esc(haQuanto(d.erpEm)) + '</span><button id="rodar-estoque" type="button">Sincronizar agora</button></div>' +
    '<div class="painel"><table><thead><tr><th>SKU</th><th>Anúncio</th><th>Situação no ML</th><th class="n">Estoque ERP</th><th class="n">Estoque ML</th>' +
    '<th class="n">Preço loja</th><th class="n">Preço ML</th><th class="n">Preço alvo</th><th>Última ação</th></tr></thead><tbody>' +
    filtrados.slice(0, 600).map((p) => "<tr><td>" + esc(p.sku || "—") + '</td><td><a href="https://produto.mercadolivre.com.br/' + esc(String(p.item_id).replace(/^MLB/, "MLB-")) + '" target="_blank" rel="noopener">' + esc(p.item_id) + "</a></td>" +
      "<td>" + statusTxt(p) + '</td><td class="n">' + (p.disp == null ? '<span class="mut">sem cadastro</span>' : esc(p.disp)) + '</td><td class="n' + (divQtd(p) ? " warn" : "") + '">' + esc(p.qtd_ml) +
      '</td><td class="n">' + brl(p.preco_loja) + '</td><td class="n' + (divPreco(p) ? " warn" : "") + '">' + brl(p.preco_ml) + '</td><td class="n">' + brl(p.preco_alvo) +
      '</td><td class="mut" title="' + esc(p.ultima_acao || "") + '">' + (p.acao_em ? esc(hora(p.acao_em)) + " " + esc(String(p.ultima_acao || "").slice(0, 40)) : "—") + "</td></tr>").join("") +
    "</tbody></table></div>" + (filtrados.length > 600 ? '<p class="mut">Mostrando 600 de ' + filtrados.length + ". Use a busca.</p>" : "");
  $("#busca-prod").oninput = (e) => { estado.busca = e.target.value; clearTimeout(renderProdutos.t); renderProdutos.t = setTimeout(navegar, 300); };
  $("#filtro-prod").onchange = (e) => { estado.filtroProd = e.target.value; navegar(); };
  $("#rodar-estoque").onclick = async (e) => { e.target.disabled = true; e.target.textContent = "Sincronizando…"; await post("/api/estoque/rodar"); navegar(); };
}

/* ------------------------------------------------------------------ Precificação */
const TIPOS = { gold_special: "Clássico", gold_pro: "Premium" };

async function renderPrecificacao(sub) {
  if (sub !== "ml") {
    // Ante-tela: um card por marketplace (hoje só o Mercado Livre está integrado).
    $("#conteudo").innerHTML = '<p class="mut" style="margin:0 0 12px">Escolha o marketplace para ver e alterar as réguas de preço.</p>' +
      '<div class="marketplaces"><a class="mkt" href="#precificacao/ml"><img src="/logos/mercadolivre.webp" alt="Mercado Livre">' +
      '<span>Réguas do Mercado Livre</span><span class="mut">Clássico e Premium</span></a>' +
      '<div class="mkt breve" aria-disabled="true"><span>Outros marketplaces</span><span class="mut">entram aqui quando forem integrados</span></div></div>';
    return;
  }
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
    '<p style="margin:0 0 10px"><a href="#precificacao">← Marketplaces</a></p><div class="painel"><h3>Réguas vigentes — Mercado Livre</h3><p class="mut" style="margin:10px 12px 0">Preço no ML = preço de loja (tabela 0 do Sankhya) × multiplicador + acréscimo. ' +
    "Vale para os anúncios com saldo. Mudanças acima de 25% num anúncio não são aplicadas automaticamente. Depois de salvar, o ML é atualizado em até ~2 min (15 anúncios por rodada).</p>" +
    '<div class="reguas">' + Object.keys(TIPOS).map(cartao).join("") + "</div>" +
    '<div class="form-linha"><label>Quem está alterando<input id="resp" maxlength="60" placeholder="seu nome"></label>' +
    '<label style="flex:1;min-width:220px">Motivo<input id="motivo" maxlength="200" placeholder="ex.: campanha, custo de frete"></label>' +
    '<button type="button" id="simular">Simular impacto</button><button type="button" id="salvar" class="primario">Salvar régua</button></div>' +
    '<div id="simulacao" style="padding:0 12px 12px"></div></div>' +
    '<div class="painel" style="margin-top:14px"><h3>Histórico de alterações</h3><table><thead><tr><th>Quando</th><th>Quem</th><th>Régua</th><th>Motivo</th></tr></thead><tbody>' +
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
    const responsavel = $("#resp").value.trim();
    if (!responsavel) throw new Error("Informe quem está alterando.");
    const s = await post("/api/reguas/simular", { reguas: ler() });
    if (!confirm("Salvar a régua? " + s.mudam + " anúncio(s) mudam de preço no ML (" + s.sobem + " sobem, " + s.descem + " descem).")) return;
    e.target.disabled = true;
    await post("/api/reguas", { reguas: ler(), responsavel, motivo: $("#motivo").value.trim() });
    navegar();
  };
}

/* ------------------------------------------------------------------ Integração */
async function renderIntegracao(sub) {
  if (sub === "logs") return renderLogs();
  if (sub === "eventos") return renderEventos();
  if (sub === "nfs") return renderNfs();
  const s = await api("/api/integracao");
  const agora = s.agora;
  const saudeMl = !s.ml.tokenOk ? "err" : s.ml.eventosComErro ? "warn" : "ok";
  const saudeHub = !s.skyhub.ultimaRodada || agora - s.skyhub.ultimaRodada > 6 * 60_000 ? "err" : s.skyhub.rodadaAbortada ? "warn" : "ok";
  const saudeSk = !s.sankhya.ultimaLeitura || agora - s.sankhya.ultimaLeitura > 6 * 60_000 ? "err" : "ok";
  const txt = { ok: "operando", warn: "atenção", err: "sem resposta" };
  const via = (seta, rotulo, valor, detalhe) => '<div class="via"><span class="seta">' + seta + "</span>" + esc(rotulo) + " <b>" + esc(valor) + '</b><span class="mut">' + esc(detalhe) + "</span></div>";
  const h = s.hoje;
  $("#conteudo").innerHTML =
    '<div class="painel"><div class="diagrama">' +
    '<div class="no"><img src="/logos/mercadolivre.webp" alt="Mercado Livre"><div class="estado"><span class="ponto ' + saudeMl + '"></span>' + txt[saudeMl] + "</div>" +
      '<div class="det">token ' + (s.ml.tokenOk ? "válido até " + esc(hora(s.ml.expiraEm)) : "INVÁLIDO") + "<br>último aviso " + esc(haQuanto(s.ml.ultimoEvento)) + "</div></div>" +
    '<div class="ligacao">' + via("→", "Vendas recebidas hoje", h.eventosRecebidos, "webhook em tempo real") +
      via("←", "XML de NF enviados hoje", h.xmlEnviados, "libera a etiqueta") +
      via("←", "Estoque/preço ajustados hoje", h.ajustesAnuncio, (h.falhasAnuncio ? h.falhasAnuncio + " falha(s) · " : "") + "a cada 2 min") +
      via("←", "Etiquetas baixadas hoje", h.etiquetasBaixadas, "PDF 10x15") + "</div>" +
    '<div class="no"><span class="skyhub-marca">SkyHub</span><div class="estado"><span class="ponto ' + saudeHub + '"></span>' + txt[saudeHub] + "</div>" +
      '<div class="det">última rodada ' + esc(haQuanto(s.skyhub.ultimaRodada)) + (s.skyhub.rodadaAbortada ? '<br><span class="warn">abortada: ' + esc(s.skyhub.rodadaAbortada) + "</span>" : "") +
      "<br>" + esc(s.skyhub.eventosPendentes) + " evento(s) na fila · " + esc(h.errosLog) + " erro(s) hoje</div></div>" +
    '<div class="ligacao">' + via("→", "Pedidos gravados hoje", h.pedidosGravados, "parceiro + pedido 1090") +
      via("←", "Leitura de estoque e preço", haQuanto(s.sankhya.ultimaLeitura), "tabela 0 e TGFEST") + "</div>" +
    '<div class="no"><img src="/logos/sankhya.svg" alt="Sankhya"><div class="estado"><span class="ponto ' + saudeSk + '"></span>' + txt[saudeSk] + "</div>" +
      '<div class="det">última leitura ' + esc(haQuanto(s.sankhya.ultimaLeitura)) + (s.sankhya.ultimoErro ? '<br><span class="mut">último erro ' + esc(haQuanto(s.sankhya.ultimoErro.em)) + "</span>" : "") + "</div></div>" +
    "</div></div>" +
    '<div class="painel" style="margin-top:14px"><h3>Modos de operação</h3><table><tbody>' +
    [["Pedidos → Sankhya", s.modos.pedidos], ["XML da NF → ML", s.modos.xml], ["Cancelamento no Sankhya", s.modos.cancelamento], ["Estoque → ML", s.modos.estoque], ["Preço → ML", s.modos.preco]]
      .map(([n, m]) => "<tr><td>" + esc(n) + '</td><td><span class="tag ' + (m === "automatico" ? "ok" : m === "manual" ? "warn" : "") + '">' + esc(m) + "</span></td></tr>").join("") +
    "</tbody></table></div>";
}

async function renderLogs() {
  const d = await api("/api/log");
  const nivel = { erro: "err", aviso: "warn", info: "ok" };
  $("#conteudo").innerHTML = '<div class="barra"><input id="busca-log" type="search" placeholder="filtrar mensagens" aria-label="Filtrar logs"><select id="nivel-log" aria-label="Nível">' +
    '<option value="">todos os níveis</option><option value="erro">erro</option><option value="aviso">aviso</option><option value="info">info</option></select></div>' +
    '<div class="painel"><table><thead><tr><th>Quando</th><th>Nível</th><th>Pedido</th><th>Mensagem</th></tr></thead><tbody id="tb-log"></tbody></table></div>';
  const desenhar = () => {
    const q = $("#busca-log").value.toLowerCase(), n = $("#nivel-log").value;
    $("#tb-log").innerHTML = d.log.filter((l) => (!n || l.nivel === n) && (!q || String(l.msg).toLowerCase().includes(q) || String(l.chave || "").includes(q)))
      .map((l) => "<tr><td>" + esc(dt(l.em)) + '</td><td><span class="tag ' + (nivel[l.nivel] || "") + '">' + esc(l.nivel) + "</span></td><td>" + esc(l.chave || "—") + "</td><td>" + esc(l.msg) + "</td></tr>").join("");
  };
  $("#busca-log").oninput = desenhar; $("#nivel-log").onchange = desenhar; desenhar();
}

async function renderEventos() {
  const d = await api("/api/eventos");
  $("#conteudo").innerHTML = '<div class="painel"><table><thead><tr><th>ID</th><th>Recebido</th><th>Tópico</th><th>Recurso</th><th>Status</th><th class="n">Tent.</th><th>Erro</th><th></th></tr></thead><tbody>' +
    d.eventos.map((e) => "<tr><td>" + e.id + "</td><td>" + esc(dt(e.recebido_em)) + "</td><td>" + esc(e.topic) + "</td><td>" + esc(e.resource) +
      '</td><td><span class="tag ' + ({ ok: "ok", erro: "err", pendente: "warn" }[e.status] || "") + '">' + esc(e.status) + '</span></td><td class="n">' + e.tentativas +
      '</td><td class="mut">' + esc(e.erro || "") + "</td><td>" + (e.status === "erro" ? '<button type="button" data-reabrir="' + e.id + '">reabrir</button>' : "") + "</td></tr>").join("") + "</tbody></table></div>";
}

async function renderNfs() {
  const d = await api("/api/nfs");
  const cor = { enviado: "ok", ja_no_ml: "ok", pronto: "info", aguardando_ml: "warn", erro: "err", divergente: "err", cancelado: "", nao_se_aplica: "" };
  $("#conteudo").innerHTML = '<div class="barra"><span class="mut">Envio do XML: modo <b>' + esc(d.xmlModo) + '</b></span><span class="espaco"></span><button type="button" id="varrer">Varrer NFs faturadas agora</button></div>' +
    '<div class="painel"><table><thead><tr><th>Atualizado</th><th>Pedido ML</th><th>NF</th><th>Envio</th><th>Logística</th><th>Status</th><th>Detalhe</th><th></th></tr></thead><tbody>' +
    d.nfs.map((n) => "<tr><td>" + esc(dt(n.atualizado_em)) + "</td><td>" + esc(n.chave) + "</td><td>" + esc(nfDaChave(n.fiscal_key) || "—") + " <span class='mut'>(" + esc(n.nunota_nf) + ")</span></td><td>" +
      esc(n.shipment_id || "—") + "</td><td>" + esc(n.logistica || "—") + '</td><td><span class="tag ' + (cor[n.status] || "") + '">' + esc(n.status) + '</span></td><td class="mut">' + esc(n.detalhe || "") +
      "</td><td>" + (n.status === "pronto" || n.status === "erro" ? '<button type="button" data-acao="xml" data-chave="' + esc(n.chave) + '">Enviar XML</button>' : "") + "</td></tr>").join("") + "</tbody></table></div>";
  $("#varrer").onclick = async (e) => { e.target.disabled = true; e.target.textContent = "Varrendo…"; await post("/api/nfs/varrer"); navegar(); };
}

/* ------------------------------------------------------------------ eventos globais */
document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("button, [data-ped]");
  if (!b) return;
  try {
    if (b.id === "entrar") {
      token = $("#tk").value.trim();
      try { sessionStorage.setItem("skyhub_tk", token); } catch { /* ignora */ }
      await carregarModos();
      return navegar();
    }
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
      alert("Gravado: pedido " + (d.pedido.nunota ?? "?"));
      $("#gaveta").hidden = true; return navegar();
    }
    if (b.dataset.acao === "xml") {
      if (!confirm("Enviar ao Mercado Livre o XML da NF deste pedido? Isso libera a etiqueta.")) return;
      b.disabled = true;
      const d = await post("/api/nfs/" + b.dataset.chave + "/enviar");
      alert("Resultado: " + d.status + (d.nf && d.nf.detalhe ? " — " + d.nf.detalhe : ""));
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
// Números dos submenus da Expedição em dia, sem recarregar a tela.
setInterval(atualizarContagemExpedicao, 60_000);

if (token) { $("#tk").value = ""; carregarModos(); atualizarContagemExpedicao(); }
navegar();
