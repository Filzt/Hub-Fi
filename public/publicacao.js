// SkyHub — Publicar anúncios pelo SKU (módulo "publicacao").
// Fila: SKU ativo no Sankhya, com saldo e sem anúncio, com a ficha do ML sugerida pelo
// casamento. Nada vai ao ML sem clique: Conferir → escolher ficha e tipo → Publicar.
// Aqui também mora a tela Envio Flex (anúncios do ML).
// Carregado antes do app.js; usa $, esc, api, post, brl, dt, erro, avisar de lá.
"use strict";

const pub = { dados: null, filtro: "com", busca: "" };
const NOME_TIPO = { gold_special: "Clássico", gold_pro: "Premium" };

async function renderPublicacao(sub) {
  if (sub === "historico") return renderHistoricoPub();
  pub.dados = await api("/api/publicacao/fila");
  desenharFilaPub();
}

function resumoPub(itens) {
  const com = itens.filter((i) => i.fichas.length).length;
  const pend = itens.filter((i) => !i.casado).length;
  const sem = itens.length - com - pend;
  return { com, sem, pend };
}

function desenharFilaPub() {
  const d = pub.dados;
  const r = resumoPub(d.itens);
  const termo = pub.busca.trim().toUpperCase();
  const lista = d.itens
    .filter((i) => (pub.filtro === "com" ? i.fichas.length : pub.filtro === "sem" ? i.casado && !i.fichas.length : true))
    .filter((i) => !termo || i.sku.includes(termo) || i.produto.toUpperCase().includes(termo));
  $("#conteudo").innerHTML =
    '<div class="cards">' +
    '<div class="card"><b>' + r.com + '</b><span>Com ficha sugerida</span></div>' +
    '<div class="card"><b>' + r.sem + '</b><span>Sem ficha no pool</span></div>' +
    (r.pend ? '<div class="card"><b>' + r.pend + '</b><span>Casamento em andamento</span></div>' : "") +
    '<div class="card"><b>' + Number(d.totalFichas).toLocaleString("pt-BR") + '</b><span>Fichas no pool</span></div></div>' +
    '<div class="barra"><div class="chips">' +
    [["com", "Com ficha"], ["sem", "Sem ficha"], ["todos", "Todos"]].map(([k, t]) =>
      '<button type="button" class="chip-filtro' + (pub.filtro === k ? " ativo" : "") + '" data-pub-filtro="' + k + '">' + t + "</button>").join("") +
    '</div><input id="busca-pub" type="search" placeholder="SKU ou modelo" value="' + esc(pub.busca) + '" aria-label="Buscar SKU">' +
    '<span class="espaco"></span><span class="atualizado mut">Sankhya lido ' + esc(d.atualizadoEm ? dt(d.atualizadoEm) : "nunca") + "</span>" +
    '<button id="atualizar-pub" type="button" class="icone" title="Reler o Sankhya e casar de novo" aria-label="Reler o Sankhya e casar de novo">↻</button></div>' +
    '<form id="form-familia" class="barra familia"><label for="link-familia" class="mut">Modelo sem ficha?</label>' +
    '<input id="link-familia" placeholder="cole o link da ficha recondicionada no ML (…/p/MLB20…)">' +
    '<button type="submit">Adicionar família de fichas</button></form>' +
    (d.duplicados && d.duplicados.length ? '<p class="dica">SKU duplicado no Sankhya (fica fora da fila até corrigir o cadastro): ' + esc(d.duplicados.join(", ")) + "</p>" : "") +
    '<div class="painel"><table><thead><tr><th>SKU</th><th>Produto</th><th>Grau</th><th class="n">Saldo</th><th class="n">Preço Clássico</th><th>Ficha sugerida</th><th></th></tr></thead><tbody>' +
    (lista.map((i) => {
      const f = i.fichas[0];
      const ultima = i.ultima_publicacao;
      const tagUltima = ultima ? ' <span class="tag ' + (ultima.status === "erro" ? "err" : "ok") + '" title="' + esc(ultima.detalhe || "") + '">' +
        (ultima.status === "erro" ? "última tentativa recusada" : "publicado " + esc(ultima.mlb || "")) + "</span>" : "";
      return "<tr><td><b>" + esc(i.sku) + "</b></td><td>" + esc(i.produto) + tagUltima + "</td><td>" + esc(i.grau_ml || i.qualidade || "—") +
        '</td><td class="n">' + esc(i.disp) + '</td><td class="n">' + brl(i.precos.gold_special) + "</td><td>" +
        (f ? '<a href="https://www.mercadolivre.com.br/p/' + esc(f.pdp) + '" target="_blank" rel="noopener">' + esc(f.nome) + "</a>" +
          (i.fichas.length > 1 ? ' <span class="mut">+' + (i.fichas.length - 1) + "</span>" : "") +
          (f.ocupada_classico ? ' <span class="tag warn">Clássico já ocupado</span>' : "")
          : '<span class="mut">' + esc(i.motivo || "—") + "</span>") +
        "</td><td>" + (f ? '<button type="button" class="primario" data-conferir="' + esc(i.sku) + '">Conferir</button>' : "") + "</td></tr>";
    }).join("") || '<tr><td colspan="7" class="mut">Nada nesta lista.</td></tr>') +
    "</tbody></table></div>";

  $("#busca-pub").oninput = (e) => { pub.busca = e.target.value; clearTimeout(desenharFilaPub.t); desenharFilaPub.t = setTimeout(() => { desenharFilaPub(); const b = $("#busca-pub"); b.focus(); b.setSelectionRange(b.value.length, b.value.length); }, 250); };
  $("#atualizar-pub").onclick = async (e) => {
    e.target.disabled = true;
    try { const x = await post("/api/publicacao/atualizar"); avisar(x.candidatos + " SKUs lidos do Sankhya, " + x.casados + " casados agora."); await renderPublicacao(); }
    catch (x) { erro(x); } finally { if ($("#atualizar-pub")) $("#atualizar-pub").disabled = false; }
  };
  $("#form-familia").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector("button");
    b.disabled = true;
    try {
      const x = await post("/api/publicacao/familia", { link: $("#link-familia").value });
      avisar(x.lidas + " fichas adicionadas" + (x.na_fila ? " (+" + x.na_fila + " chegando nos próximos minutos)" : "") + ". O casamento refaz sozinho.");
      $("#link-familia").value = "";
    } catch (x) { erro(x); } finally { b.disabled = false; }
  };
}

// ------------------------------------------------------------------ conferência
async function conferirPub(sku) {
  $("#gaveta-titulo").textContent = "Conferir " + sku;
  $("#gaveta-corpo").innerHTML = '<p class="vazio">Consultando as fichas no Mercado Livre…</p>';
  $("#gaveta").hidden = false;
  const d = await api("/api/publicacao/sku/" + encodeURIComponent(sku));
  const x = d.sku;
  const fichaOk = (f) => f.status === "active" && f.categoria;
  const primeira = d.fichas.find(fichaOk);
  $("#gaveta-corpo").innerHTML =
    '<div class="painel"><b>' + esc(x.produto) + '</b><div class="mut">' + esc(x.sku) + " · " + esc(x.marca) + " · " + esc(x.capacidade) + " · " + esc(x.cor) +
    " · " + esc(x.qualidade) + " → ML " + esc(d.grau_ml || "—") + '</div><div>Saldo no Sankhya: <b>' + esc(x.disp) + "</b> · Preço de loja (tabela 0): <b>" + brl(x.preco_loja) + "</b></div></div>" +
    '<form id="form-publicar">' +
    '<h3>Ficha do ML</h3><p class="dica">Confira modelo, cor, capacidade e grau na foto e no título. Vínculo errado vira reclamação — e a conta já tem 3 advertências.</p>' +
    d.fichas.map((f) => {
      const ok = fichaOk(f);
      return '<label class="ficha' + (ok ? "" : " indisponivel") + '"><input type="radio" name="pdp" value="' + esc(f.pdp) + '"' + (f === primeira ? " checked" : "") + (ok ? "" : " disabled") + ">" +
        (f.imagem ? '<img src="' + esc(f.imagem) + '" alt="" loading="lazy">' : '<span class="sem-foto">sem foto</span>') +
        '<span class="ficha-txt"><b>' + esc(f.nome) + '</b><span class="mut">' + esc(f.pdp) + " · " + esc(f.grau || "?") + " · " + esc(f.cor || "?") + " · " + esc(f.capacidade || "?") + "</span>" +
        '<span>' + (f.concorrentes.total ? f.concorrentes.total + " anúncio(s) na ficha, menor preço " + brl(f.concorrentes.menor) + (f.concorrentes.nossos ? " (" + f.concorrentes.nossos + " nosso)" : "") : "ficha sem concorrentes") + "</span>" +
        (f.avisos || []).map((w) => '<span class="tag warn">' + esc(w) + "</span>").join("") +
        (f.ocupada.length ? '<span class="tag warn">já temos: ' + f.ocupada.map((o) => esc(NOME_TIPO[o.tipo] || o.tipo) + " " + esc(o.mlb)).join(", ") + "</span>" : "") +
        (!ok ? '<span class="tag err">' + (f.status !== "active" ? "ficha " + esc(f.status) : "categoria " + esc(f.dominio || "?") + " ainda não publicada") + "</span>" : "") +
        '<a href="' + esc(f.link) + '" target="_blank" rel="noopener">abrir no ML ↗</a></span></label>';
    }).join("") +
    '<h3>Tipo de anúncio</h3><div class="tipos">' +
    Object.keys(NOME_TIPO).map((t) => '<label class="check"><input type="radio" name="tipo" value="' + t + '"' + (t === "gold_special" ? " checked" : "") + "> " +
      NOME_TIPO[t] + " — " + brl(d.precos[t]) + "</label>").join("") + "</div>" +
    '<h3>Envio</h3><label class="check"><input type="checkbox" name="flex"' + (d.flexPadrao ? " checked" : "") + "> Oferecer Envio Flex (entrega no mesmo dia)</label>" +
    '<div class="acoes"><button type="submit" class="primario"' + (primeira ? "" : " disabled") + ">Publicar no Mercado Livre</button>" +
    '<span class="mut">Quantidade: ' + esc(x.disp) + " (depois o SkyHub sincroniza estoque e preço sozinho)</span></div>" +
    '<div id="resultado-pub"></div></form>';

  $("#form-publicar").onsubmit = async (e) => {
    e.preventDefault();
    const pdp = (e.target.querySelector("[name=pdp]:checked") || {}).value;
    const tipo = (e.target.querySelector("[name=tipo]:checked") || {}).value;
    const flex = e.target.querySelector("[name=flex]").checked;
    if (!pdp) return erro("Escolha a ficha.");
    if (!confirm("Publicar " + x.sku + " no Mercado Livre?\n\nFicha " + pdp + "\n" + NOME_TIPO[tipo] + " por " + brl(d.precos[tipo]) + ", " + x.disp + " un.\n" + (flex ? "Com" : "Sem") + " Envio Flex.\n\nO anúncio vai ao ar na hora.")) return;
    const b = e.target.querySelector("button[type=submit]");
    b.disabled = true; b.textContent = "Publicando…";
    try {
      const r = await post("/api/publicacao/publicar", { sku: x.sku, pdp, tipo, flex });
      $("#resultado-pub").innerHTML = '<div class="achado"><span class="ok">Publicado: <a href="' + esc(r.link) + '" target="_blank" rel="noopener">' + esc(r.mlb) +
        "</a> — " + esc(r.tipo) + " " + brl(r.preco) + ", " + esc(r.qtd) + " un. Flex " + esc(r.flex) + ". A auditoria confere em 5 minutos.</span></div>";
      b.textContent = "Publicado ✓";
      avisar("Anúncio " + r.mlb + " publicado.");
      pub.dados = await api("/api/publicacao/fila");
    } catch (x2) {
      $("#resultado-pub").innerHTML = '<div class="nao-achado">' + esc(x2.message) + "</div>";
      b.disabled = false; b.textContent = "Publicar no Mercado Livre";
    }
  };
}

// ------------------------------------------------------------------ histórico
async function renderHistoricoPub() {
  const d = await api("/api/publicacao/fila");
  const cor = { criado: "info", auditado: "ok", divergente: "warn", erro: "err" };
  $("#conteudo").innerHTML = '<div class="painel"><table><thead><tr><th>Quando</th><th>SKU</th><th>Ficha</th><th>Tipo</th><th class="n">Preço</th><th class="n">Qtd</th><th>Situação</th><th>Anúncio</th><th>Quem</th></tr></thead><tbody>' +
    (d.publicacoes.map((p) => "<tr><td>" + esc(dt(p.em)) + "</td><td><b>" + esc(p.sku) + '</b></td><td><a href="https://www.mercadolivre.com.br/p/' + esc(p.pdp) + '" target="_blank" rel="noopener">' + esc(p.pdp) +
      "</a></td><td>" + esc(NOME_TIPO[p.tipo] || p.tipo) + '</td><td class="n">' + brl(p.preco) + '</td><td class="n">' + esc(p.qtd ?? "—") + '</td><td><span class="tag ' + (cor[p.status] || "") + '" title="' + esc(p.detalhe || "") + '">' + esc(p.status) +
      '</span><div class="mut">' + esc(p.detalhe || "") + "</div></td><td>" + (p.mlb ? '<a href="https://produto.mercadolivre.com.br/' + esc(String(p.mlb).replace(/^MLB/, "MLB-")) + '" target="_blank" rel="noopener">' + esc(p.mlb) + "</a>" : "—") +
      "</td><td>" + esc(p.quem) + "</td></tr>").join("") || '<tr><td colspan="9" class="mut">Nenhuma publicação ainda.</td></tr>') +
    "</tbody></table></div>";
}

document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-pub-filtro], [data-conferir]");
  if (!b) return;
  try {
    if (b.dataset.pubFiltro) { pub.filtro = b.dataset.pubFiltro; return desenharFilaPub(); }
    if (b.dataset.conferir) return await conferirPub(b.dataset.conferir);
  } catch (e) { erro(e); }
});

// ------------------------------------------------------------------ Envio Flex
// Liga e desliga o Flex por anúncio (a doc do ML pede que seja decisão do vendedor, por
// clique — nada disso roda sozinho). Zonas, corte e capacidade só aparecem: mudam no painel do ML.
const flexTela = { dados: null, filtro: "todos", busca: "", sel: new Set() };
const DIAS_FLEX = { week: "Segunda a sexta", saturday: "Sábado", sunday: "Domingo" };
const FILTROS_FLEX = [
  ["todos", "Anúncios ativos e pausados", () => true],
  ["com", "Com Flex", (a) => a.flex === 1],
  ["sem", "Sem Flex", (a) => a.flex === 0],
  ["nao_lido", "Ainda não lidos", (a) => a.flex == null],
];

async function renderFlex() {
  flexTela.dados = await api("/api/flex");
  const ids = new Set(flexTela.dados.anuncios.map((a) => a.item_id));
  flexTela.sel = new Set([...flexTela.sel].filter((id) => ids.has(id)));
  desenharFlex();
}

function resumoConfigFlex(c) {
  if (c.erro && !c.assinatura) return '<p class="nao-achado">Não consegui ler a assinatura Flex: ' + esc(c.erro) + "</p>";
  const faixa = (d) => {
    const f = (c.faixas[d] || [])[0];
    return f ? "corte " + f.cutoff + "h · entrega " + f.from + "h–" + f.to + "h · até " + f.capacity + " pedidos" : '<span class="mut">não entrega</span>';
  };
  return '<dl class="dados"><dt>Assinatura</dt><dd>' + (c.assinatura === "in" ? '<span class="tag ok">ativa</span>' : '<span class="tag warn">' + esc(c.assinatura || "—") + "</span>") + "</dd>" +
    "<dt>Saída</dt><dd>" + esc(c.origem || "—") + "</dd>" +
    "<dt>Prazo</dt><dd>" + (c.janela === "same_day" ? "entrega no mesmo dia" : c.janela === "next_day" ? "entrega no dia seguinte" : esc(c.janela || "—")) + "</dd>" +
    Object.keys(DIAS_FLEX).map((d) => "<dt>" + DIAS_FLEX[d] + "</dt><dd>" + faixa(d) + "</dd>").join("") +
    "<dt>Zonas</dt><dd>" + (c.zonas.length ? c.zonas.map((z) => esc(z.replace(/^BR-SP-/, "SP "))).join(", ") : "—") + "</dd></dl>" +
    '<p class="dica">Zonas, horário de corte e capacidade se mudam no painel do Mercado Livre (Vendas → Envios Flex).</p>';
}

function desenharFlex() {
  const d = flexTela.dados;
  const termo = flexTela.busca.trim().toUpperCase();
  const f = (FILTROS_FLEX.find(([k]) => k === flexTela.filtro) || FILTROS_FLEX[0])[2];
  const lista = d.anuncios.filter(f).filter((a) => !termo || a.item_id.includes(termo) || String(a.sku).includes(termo) || String(a.produto || "").toUpperCase().includes(termo));
  const n = flexTela.sel.size;
  $("#conteudo").innerHTML =
    '<div class="nao-achado aviso-flex">Flex é entrega no mesmo dia feita por vocês. Cada anúncio ligado pode gerar pedido com prazo de horas; atraso derruba a reputação da conta.</div>' +
    '<div class="painel"><h3>Configuração Flex da conta</h3><div class="corpo-painel">' + resumoConfigFlex(d.config) +
    '<label class="check forte"><input type="checkbox" id="flex-novos"' + (d.novosComFlex ? " checked" : "") + "> Novos anúncios publicados pelo SkyHub já saem com Flex</label></div></div>" +
    '<div class="cards">' + FILTROS_FLEX.map(([k, t, fn]) => {
      const q = d.anuncios.filter(fn).length;
      if (k === "nao_lido" && !q) return "";
      return '<button type="button" class="card clicavel' + (flexTela.filtro === k ? " ativo" : "") + '" data-filtro-flex="' + k + '" aria-pressed="' + (flexTela.filtro === k) + '"><b>' + q + "</b><span>" + esc(t) + "</span></button>";
    }).join("") + "</div>" +
    '<div class="barra"><input id="busca-flex" type="search" placeholder="MLB, SKU ou produto" value="' + esc(flexTela.busca) + '" aria-label="Buscar anúncio">' +
    '<span class="espaco"></span><span class="dica" id="info-flex">' + (n ? n + " selecionado(s)" : "Marque os anúncios na lista") + "</span>" +
    '<button type="button" id="flex-desligar"' + (n ? "" : " disabled") + ">Desativar Flex</button>" +
    '<button type="button" class="primario" id="flex-ligar"' + (n ? "" : " disabled") + ">Ativar Flex" + (n ? " (" + n + ")" : "") + "</button></div>" +
    '<div id="resultado-flex"></div>' +
    '<div class="painel"><table><thead><tr><th class="sel"><input type="checkbox" id="flex-todos" aria-label="Selecionar todos os visíveis"></th><th>Anúncio</th><th>SKU</th><th>Produto</th><th>Situação</th><th class="n">Estoque</th><th>Flex</th></tr></thead><tbody id="tb-flex">' +
    (lista.map((a) => '<tr class="' + (flexTela.sel.has(a.item_id) ? "sel" : "") + '"><td class="sel"><input type="checkbox" data-sel-flex="' + esc(a.item_id) + '"' + (flexTela.sel.has(a.item_id) ? " checked" : "") + ' aria-label="Selecionar ' + esc(a.item_id) + '"></td>' +
      '<td><a href="https://produto.mercadolivre.com.br/' + esc(a.item_id.replace(/^MLB/, "MLB-")) + '" target="_blank" rel="noopener">' + esc(a.item_id) + "</a></td><td><b>" + esc(a.sku || "—") + '</b></td><td class="prod-nome">' + esc(a.produto || "—") + "</td>" +
      "<td>" + situacaoAnuncio(a) + '</td><td class="n">' + esc(a.qtd_ml) + "</td><td>" +
      (a.flex === 1 ? '<span class="tag ok">com Flex</span>' : a.flex === 0 ? '<span class="tag">sem Flex</span>' : '<span class="mut">lendo…</span>') + "</td></tr>").join("") ||
      '<tr><td colspan="7" class="vazio">Nenhum anúncio neste filtro.</td></tr>') + "</tbody></table></div>";

  const visiveis = () => $$("#tb-flex input[data-sel-flex]");
  $("#flex-todos").checked = visiveis().length > 0 && visiveis().every((c) => c.checked);
  $("#tb-flex").addEventListener("change", (ev) => {
    const c = ev.target.closest("input[data-sel-flex]");
    if (!c) return;
    c.checked ? flexTela.sel.add(c.dataset.selFlex) : flexTela.sel.delete(c.dataset.selFlex);
    desenharFlex();
  });
  $("#flex-todos").onchange = (ev) => { visiveis().forEach((c) => (ev.target.checked ? flexTela.sel.add(c.dataset.selFlex) : flexTela.sel.delete(c.dataset.selFlex))); desenharFlex(); };
  $("#busca-flex").oninput = (e) => {
    flexTela.busca = e.target.value;
    clearTimeout(desenharFlex.t);
    desenharFlex.t = setTimeout(() => { desenharFlex(); const x = $("#busca-flex"); x.focus(); x.setSelectionRange(x.value.length, x.value.length); }, 250);
  };
  $("#flex-ligar").onclick = () => mudarFlex(true).catch(erro);
  $("#flex-desligar").onclick = () => mudarFlex(false).catch(erro);
  $("#flex-novos").onchange = async (e) => {
    try { await post("/api/flex/novos", { ativo: e.target.checked }); avisar(e.target.checked ? "Novos anúncios vão sair com Flex." : "Novos anúncios vão sair sem Flex."); d.novosComFlex = e.target.checked; }
    catch (x) { e.target.checked = !e.target.checked; erro(x); }
  };
}

/** Envia em lotes de 20 (teto por chamada do SkyHub). A sincronização confirma no ML em seguida. */
async function mudarFlex(ativar) {
  const ids = [...flexTela.sel];
  if (!ids.length) return;
  const c = flexTela.dados.config;
  const faixa = (c.faixas.week || [])[0];
  const msg = ativar
    ? "Ativar Flex em " + ids.length + " anúncio(s)?\n\nPedido Flex é entrega no mesmo dia" + (faixa ? " (corte " + faixa.cutoff + "h, até " + faixa.capacity + " pedidos por dia)" : "") + ", feita por vocês."
    : "Desativar Flex em " + ids.length + " anúncio(s)? Eles seguem vendendo pela coleta normal.";
  if (!confirm(msg)) return;
  limparErro();
  $$("#flex-ligar, #flex-desligar").forEach((b) => { b.disabled = true; });
  const resultados = [];
  try {
    for (let i = 0; i < ids.length; i += 20) {
      $("#info-flex").textContent = (ativar ? "Ativando" : "Desativando") + "… " + Math.min(i + 20, ids.length) + " de " + ids.length;
      const r = await post("/api/flex", { ids: ids.slice(i, i + 20), ativar });
      resultados.push(...r.resultados);
    }
  } finally {
    const porId = new Map(resultados.map((r) => [r.item_id, r]));
    flexTela.dados.anuncios.forEach((a) => { const r = porId.get(a.item_id); if (r && r.flex != null) a.flex = r.flex; });
    resultados.filter((r) => r.ok).forEach((r) => flexTela.sel.delete(r.item_id));
    desenharFlex();
    const falhas = resultados.filter((r) => !r.ok);
    if (resultados.length) avisar((ativar ? "Flex ativado" : "Flex desativado") + " em " + (resultados.length - falhas.length) + " de " + resultados.length + ".");
    if (falhas.length) $("#resultado-flex").innerHTML = '<div class="nao-achado">Não mudaram (seguem selecionados): ' + falhas.map((f) => esc(f.item_id) + " — " + esc(f.detalhe)).join("<br>") + "</div>";
  }
}

document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-filtro-flex]");
  if (!b) return;
  flexTela.filtro = b.dataset.filtroFlex;
  desenharFlex();
});
