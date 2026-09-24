// Painel de operação (HTML estático). Os dados vêm de /api/* com o ADMIN_TOKEN,
// guardado só no sessionStorage do navegador. Proteção definitiva: Cloudflare Access.

export const PAINEL_HTML = /* html */ `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SkyHub</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --tx:#1d2330; --mut:#667085; --bd:#e3e6eb;
          --ok:#0f7b3f; --warn:#a15c00; --err:#b42318; --info:#1f5fbf; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#12151b; --card:#1b1f27; --tx:#e7e9ee; --mut:#98a1b2; --bd:#2c323d;
            --ok:#4cc38a; --warn:#f0a93b; --err:#f97066; --info:#7aa7ff; }
  }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--tx); font:14px/1.45 system-ui, sans-serif }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between;
           padding:14px 16px; border-bottom:1px solid var(--bd); background:var(--card) }
  h1 { font-size:17px; margin:0 } .modo { color:var(--warn); font-weight:600 }
  main { padding:16px; max-width:1300px; margin:0 auto }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:16px }
  .card { background:var(--card); border:1px solid var(--bd); border-radius:8px; padding:10px 12px }
  .card b { display:block; font-size:20px } .card span { color:var(--mut); font-size:12px }
  .tabs { display:flex; gap:6px; margin-bottom:10px; flex-wrap:wrap }
  button { font:inherit; border:1px solid var(--bd); background:var(--card); color:var(--tx);
           border-radius:6px; padding:6px 10px; cursor:pointer }
  button.ativo { border-color:var(--info); color:var(--info) }
  .wrap { overflow-x:auto; background:var(--card); border:1px solid var(--bd); border-radius:8px }
  table { border-collapse:collapse; width:100%; min-width:760px }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--bd); vertical-align:top }
  th { color:var(--mut); font-weight:600; font-size:12px } td.n { text-align:right; white-space:nowrap }
  .s { font-weight:600 } .no_erp,.gravado,.ok { color:var(--ok) } .pronto { color:var(--info) }
  .divergente,.aguardando_pagamento,.pendente,.gravando { color:var(--warn) }
  button.gravar { border-color:var(--info); color:var(--info); font-weight:600 }
  .bloqueado,.cancelado,.erro { color:var(--err) } .ignorado { color:var(--mut) }
  pre { white-space:pre-wrap; word-break:break-word; background:var(--bg); padding:10px; border-radius:6px; font-size:12px; margin:0 }
  .mut { color:var(--mut) } #msg { color:var(--err); margin:8px 0 }
</style>
</head>
<body>
<header>
  <h1>SkyHub · ML ↔ Sankhya <span class="modo" id="modo"></span></h1>
  <div><input id="tk" type="password" placeholder="ADMIN_TOKEN" aria-label="Token de acesso">
       <button id="entrar">Entrar</button></div>
</header>
<main>
  <div id="msg" role="alert"></div>
  <div class="cards" id="cards"></div>
  <div class="tabs">
    <button data-aba="pedidos" class="ativo">Pedidos</button>
    <button data-aba="eventos">Eventos</button>
    <button data-aba="log">Log</button>
    <button id="recarregar">Recarregar</button>
  </div>
  <div class="wrap" id="conteudo"><p class="mut" style="padding:12px">Informe o token para carregar.</p></div>
</main>
<script>
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const brl = (v) => Number(v ?? 0).toLocaleString("pt-BR", {style:"currency", currency:"BRL"});
const dt = (ms) => ms ? new Date(ms).toLocaleString("pt-BR") : "";
let token = ""; try { token = sessionStorage.getItem("skyhub_tk") || ""; } catch {}
let aba = "pedidos";
let modo = "";

async function api(caminho, opt = {}) {
  const r = await fetch(caminho, { ...opt, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
  if (r.status === 401) throw new Error("Token inválido.");
  const d = await r.json();
  if (!r.ok) throw new Error(d.erro || ("HTTP " + r.status));
  return d;
}

async function carregar() {
  $("#msg").textContent = "";
  try {
    const s = await api("/api/saude");
    modo = s.modo;
    $("#modo").textContent = "· modo " + s.modo;
    const cont = (lista, k) => Object.fromEntries((lista || []).map((x) => [x[k], x.n]));
    const p = cont(s.store.pedidos, "situacao"), e = cont(s.store.eventos, "status");
    const cards = [
      ["Token ML", s.meli.semeado ? "expira " + dt(s.meli.expiraEm) : "NÃO SEMEADO"],
      ["Prontos p/ gravar", p.pronto || 0], ["No ERP", p.no_erp || 0], ["Divergentes", p.divergente || 0],
      ["Bloqueados", p.bloqueado || 0], ["Cancelados", p.cancelado || 0],
      ["Eventos com erro", e.erro || 0], ["Último evento", dt(s.store.ultimoEventoEm) || "—"],
    ];
    $("#cards").innerHTML = cards.map(([t, v]) => '<div class="card"><b>' + esc(v) + "</b><span>" + esc(t) + "</span></div>").join("");
    await ({ pedidos, eventos, log })[aba]();
  } catch (err) { $("#msg").textContent = err.message; }
}

async function pedidos() {
  const d = await api("/api/pedidos");
  $("#conteudo").innerHTML = "<table><thead><tr><th>Data ML</th><th>Chave</th><th>Situação</th><th>Total</th><th>Comissão</th><th>Frete</th><th>Parceiro</th><th>ERP (TOP:NUNOTA)</th><th>Gravação</th><th></th></tr></thead><tbody>" +
    d.pedidos.map((p) => "<tr><td>" + esc(new Date(p.data_ml).toLocaleString("pt-BR")) + "</td><td>" + esc(p.chave) +
      '</td><td class="s ' + esc(p.situacao) + '">' + esc(p.situacao) + '</td><td class="n">' + brl(p.total) +
      '</td><td class="n">' + brl(p.comissao) + '</td><td class="n">' + brl(p.frete) + "</td><td>" + esc(p.codparc ?? "—") +
      "</td><td>" + esc(p.nunotas_base ?? "—") + '</td><td class="s ' + esc(p.gravacao || "") + '" title="' + esc(p.gravacao_erro || "") + '">' +
      esc(p.gravacao ? p.gravacao + (p.nunota ? " " + p.nunota : "") : "—") +
      '</td><td><button data-ver="' + esc(p.chave) + '">detalhe</button> <button data-proc="' + esc(p.order_ids.split(",")[0]) + '">reprocessar</button>' +
      (p.situacao === "pronto" && modo !== "sombra" ? ' <button class="gravar" data-gravar="' + esc(p.order_ids.split(",")[0]) + '" data-chave="' + esc(p.chave) +
        '" data-total="' + esc(brl(p.total)) + '">gravar no Sankhya</button>' : "") +
      "</td></tr>").join("") + "</tbody></table>";
}

async function eventos() {
  const d = await api("/api/eventos");
  $("#conteudo").innerHTML = "<table><thead><tr><th>ID</th><th>Recebido</th><th>Tópico</th><th>Resource</th><th>Status</th><th>Tent.</th><th>Erro</th><th></th></tr></thead><tbody>" +
    d.eventos.map((e) => "<tr><td>" + e.id + "</td><td>" + dt(e.recebido_em) + "</td><td>" + esc(e.topic) + "</td><td>" + esc(e.resource) +
      '</td><td class="s ' + esc(e.status) + '">' + esc(e.status) + "</td><td>" + e.tentativas + '</td><td class="mut">' + esc(e.erro) +
      '</td><td><button data-reabrir="' + e.id + '">reabrir</button></td></tr>').join("") + "</tbody></table>";
}

async function log() {
  const d = await api("/api/log");
  $("#conteudo").innerHTML = "<table><thead><tr><th>Quando</th><th>Nível</th><th>Chave</th><th>Mensagem</th></tr></thead><tbody>" +
    d.log.map((l) => "<tr><td>" + dt(l.em) + '</td><td class="s ' + (l.nivel === "erro" ? "erro" : l.nivel === "aviso" ? "pendente" : "ok") + '">' +
      esc(l.nivel) + "</td><td>" + esc(l.chave) + "</td><td>" + esc(l.msg) + "</td></tr>").join("") + "</tbody></table>";
}

document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  try {
    if (b.dataset.aba) { aba = b.dataset.aba; document.querySelectorAll("[data-aba]").forEach((x) => x.classList.toggle("ativo", x === b)); return carregar(); }
    if (b.id === "recarregar") return carregar();
    if (b.id === "entrar") { token = $("#tk").value.trim(); try { sessionStorage.setItem("skyhub_tk", token); } catch {} return carregar(); }
    if (b.dataset.ver) {
      const d = await api("/api/pedidos/" + encodeURIComponent(b.dataset.ver));
      const nota = d.pedido.nota_json ? JSON.stringify(JSON.parse(d.pedido.nota_json), null, 2) : "(nota não montada — ver bloqueio)";
      const tr = b.closest("tr"); const prox = tr.nextElementSibling;
      if (prox && prox.classList.contains("det")) return prox.remove();
      tr.insertAdjacentHTML("afterend", '<tr class="det"><td colspan="10"><pre>' + esc(JSON.stringify(JSON.parse(d.pedido.analise_json), null, 2)) +
        "</pre><p class=mut>incluirNota montado (CODPARC 0 = parceiro será criado na gravação):</p><pre>" + esc(nota) + "</pre></td></tr>");
    }
    if (b.dataset.gravar) {
      if (!confirm("Gravar no Sankhya o pedido " + b.dataset.chave + " (" + b.dataset.total + ")?

Cria o parceiro se for comprador novo e o pedido 1090.")) return;
      b.disabled = true; b.textContent = "gravando...";
      const d = await api("/api/pedidos/" + b.dataset.gravar + "/gravar", { method: "POST" });
      alert("Gravado: NUNOTA " + (d.pedido.nunota ?? "?"));
      return carregar();
    }
    if (b.dataset.proc) { b.disabled = true; await api("/api/pedidos/" + b.dataset.proc + "/processar", { method: "POST" }); return carregar(); }
    if (b.dataset.reabrir) { await api("/api/eventos/" + b.dataset.reabrir + "/reabrir", { method: "POST" }); return carregar(); }
  } catch (err) { $("#msg").textContent = err.message; b.disabled = false; }
});
if (token) carregar();
</script>
</body>
</html>`;
