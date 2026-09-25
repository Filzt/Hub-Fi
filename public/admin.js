// SkyHub — Administração: usuários e funções (só para função de administrador).
// Carregado antes do app.js; usa $, esc, api, post, erro e navegar de lá (em tempo de execução).
"use strict";

const NOMES_MODULO = { pedidos: "Pedidos", expedicao: "Expedição", produtos: "Produtos", precificacao: "Precificação", integracao: "Integração" };

async function renderAdmin(sub) {
  if (sub === "funcoes") return renderFuncoes();
  return renderUsuarios();
}

const put = (caminho, corpo) => api(caminho, { method: "PUT", body: JSON.stringify(corpo) });
const del = (caminho) => api(caminho, { method: "DELETE" });

/** Checkboxes de módulos + "administrador" para o formulário de função. */
function camposFuncao(prefixo, f, modulos) {
  const adminFixo = f && f.id === "administrador";
  return '<div class="modulos">' + modulos.map((m) =>
    '<label class="check"><input type="checkbox" name="mod" value="' + esc(m) + '"' + (f && f.modulos.includes(m) ? " checked" : "") +
    (f && f.admin ? " disabled" : "") + "> " + esc(NOMES_MODULO[m] || m) + "</label>").join("") +
    '<label class="check forte"><input type="checkbox" name="admin"' + (f && f.admin ? " checked" : "") + (adminFixo ? " disabled" : "") +
    "> Administrador <span class=\"mut\">(tudo + usuários e funções)</span></label></div>";
}
const lerFuncao = (form) => ({
  nome: form.querySelector("[name=nome]").value.trim(),
  modulos: [...form.querySelectorAll("[name=mod]:checked")].map((c) => c.value),
  admin: form.querySelector("[name=admin]").checked,
});
// Marcar "Administrador" já dá tudo: trava os módulos para não parecer que falta algo.
document.addEventListener("change", (ev) => {
  if (ev.target.name !== "admin") return;
  ev.target.closest("form").querySelectorAll("[name=mod]").forEach((c) => { c.disabled = ev.target.checked; });
});

function mostrarLink(link, email) {
  const alvo = $("#link-gerado");
  if (!alvo) return;
  if (!link || /^ERRO/.test(link)) {
    alvo.innerHTML = '<div class="nao-achado">Usuário criado, mas o link de senha falhou: ' + esc(link || "sem resposta") + ". Use “Link de senha” na lista.</div>";
    return;
  }
  alvo.innerHTML = '<div class="achado link-senha"><div><b>Link para ' + esc(email) + " definir a senha</b>" +
    '<div class="mut">Mande pelo WhatsApp. Vale por pouco tempo e só uma vez; se expirar, gere outro.</div>' +
    '<input type="text" readonly id="link-valor" value="' + esc(link) + '"></div>' +
    '<button type="button" class="primario" id="copiar-link">Copiar</button></div>';
  $("#link-valor").select();
}

// ------------------------------------------------------------------ usuários
async function renderUsuarios() {
  const d = await api("/api/admin/usuarios");
  const { usuarios, funcoes } = d;
  const opcoes = (sel) => funcoes.map((f) => '<option value="' + esc(f.id) + '"' + (f.id === sel ? " selected" : "") + ">" + esc(f.nome) + "</option>").join("");
  $("#conteudo").innerHTML =
    '<div class="painel"><h3>Novo usuário</h3>' +
    '<form id="form-usuario" class="form-grade" autocomplete="off">' +
    '<label>Nome<input name="nome" required maxlength="80"></label>' +
    '<label>E-mail<input name="email" type="email" required maxlength="254"></label>' +
    '<label>Função<select name="funcao" id="sel-funcao" required><option value="">escolha…</option>' + opcoes("") + '<option value="__nova">+ Nova função…</option></select></label>' +
    '<button type="submit" class="primario">Criar usuário</button></form>' +
    '<form id="form-funcao-rapida" class="form-funcao" hidden><h4>Nova função</h4><label>Nome da função<input name="nome" maxlength="40" placeholder="ex.: Expedição"></label>' +
    camposFuncao("rapida", null, Object.keys(NOMES_MODULO)) +
    '<div class="acoes"><button type="submit" class="primario">Criar função</button><button type="button" id="cancelar-funcao-rapida">Cancelar</button></div></form>' +
    '<p class="dica">A pessoa recebe um link para definir a própria senha. Você não vê nem escolhe a senha de ninguém.</p>' +
    '<div id="link-gerado"></div></div>' +
    '<div class="painel"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Função</th><th>Situação</th><th>Último acesso</th><th></th></tr></thead><tbody>' +
    (usuarios.map((u) => '<tr class="' + (u.ativo ? "" : "inativo") + '"><td><b>' + esc(u.nome) + "</b>" + (u.eu ? ' <span class="tag">você</span>' : "") + "</td><td>" + esc(u.email) +
      '</td><td><select data-usuario-funcao="' + esc(u.id) + '"' + (u.eu ? " disabled title=\"Peça a outro administrador para mudar a sua função\"" : "") + ">" + opcoes(u.funcao) + "</select></td><td>" +
      (u.ativo ? '<span class="tag ok">ativo</span>' : '<span class="tag err">desativado</span>') + "</td><td>" + esc(u.ultimo_acesso ? dt(u.ultimo_acesso) : u.ultimo_login ? dtIso(u.ultimo_login) : "nunca entrou") +
      '</td><td class="acoes-linha"><button type="button" data-link-senha="' + esc(u.id) + '" data-email="' + esc(u.email) + '">Link de senha</button>' +
      (u.eu ? "" : '<button type="button" data-ativar="' + esc(u.id) + '" data-ativo="' + (u.ativo ? "1" : "0") + '">' + (u.ativo ? "Desativar" : "Reativar") + "</button>") +
      "</td></tr>").join("") || '<tr><td colspan="6" class="mut">Nenhum usuário.</td></tr>') +
    "</tbody></table></div>";

  const sel = $("#sel-funcao");
  sel.onchange = () => { $("#form-funcao-rapida").hidden = sel.value !== "__nova"; if (sel.value === "__nova") $("#form-funcao-rapida [name=nome]").focus(); };
  $("#cancelar-funcao-rapida").onclick = () => { $("#form-funcao-rapida").hidden = true; sel.value = ""; };

  $("#form-funcao-rapida").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const f = await post("/api/admin/funcoes", lerFuncao(ev.target));
      const opt = document.createElement("option");
      opt.value = f.funcao.id; opt.textContent = f.funcao.nome;
      sel.insertBefore(opt, sel.querySelector('option[value="__nova"]'));
      sel.value = f.funcao.id;
      ev.target.hidden = true; ev.target.reset();
      limparErro();
    } catch (e) { erro(e); }
  };

  $("#form-usuario").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    if (f.funcao.value === "__nova" || !f.funcao.value) return erro("Escolha a função (ou crie uma nova e clique em Criar função).");
    const b = f.querySelector("button[type=submit]");
    b.disabled = true;
    try {
      const d = await post("/api/admin/usuarios", { nome: f.nome.value, email: f.email.value, funcao: f.funcao.value });
      const email = f.email.value;
      await renderUsuarios();
      mostrarLink(d.link, email);
    } catch (e) { erro(e); } finally { b.disabled = false; }
  };

  $$("[data-usuario-funcao]").forEach((s) => {
    s.onchange = async () => {
      try { await put("/api/admin/usuarios/" + s.dataset.usuarioFuncao, { funcao: s.value }); avisar("Função alterada."); }
      catch (e) { erro(e); await renderUsuarios(); }
    };
  });
}

// ------------------------------------------------------------------ funções
async function renderFuncoes() {
  const d = await api("/api/admin/funcoes");
  const { funcoes, modulos } = d;
  $("#conteudo").innerHTML =
    '<div class="painel"><h3>Nova função</h3><form id="form-funcao-nova" class="form-funcao"><label>Nome da função<input name="nome" required maxlength="40" placeholder="ex.: Expedição, Financeiro, Compras"></label>' +
    camposFuncao("nova", null, modulos) + '<div class="acoes"><button type="submit" class="primario">Criar função</button></div></form></div>' +
    funcoes.map((f) => '<div class="painel"><form class="form-funcao" data-funcao="' + esc(f.id) + '">' +
      '<div class="topo-funcao"><label>Nome<input name="nome" required maxlength="40" value="' + esc(f.nome) + '"></label><span class="mut">' +
      f.usuarios + (f.usuarios === 1 ? " usuário" : " usuários") + "</span></div>" + camposFuncao(f.id, f, modulos) +
      '<div class="acoes"><button type="submit" class="primario">Salvar</button>' +
      (f.id === "administrador" ? '<span class="mut">função fixa: não pode ser apagada</span>' :
        '<button type="button" data-apagar-funcao="' + esc(f.id) + '"' + (f.usuarios ? ' disabled title="Troque a função dos usuários antes"' : "") + ">Apagar</button>") +
      "</div></form></div>").join("");

  $("#form-funcao-nova").onsubmit = async (ev) => {
    ev.preventDefault();
    try { await post("/api/admin/funcoes", lerFuncao(ev.target)); await renderFuncoes(); avisar("Função criada."); } catch (e) { erro(e); }
  };
  $$("form[data-funcao]").forEach((form) => {
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      try { await put("/api/admin/funcoes/" + form.dataset.funcao, lerFuncao(form)); await renderFuncoes(); avisar("Função salva."); } catch (e) { erro(e); }
    };
  });
}

// ------------------------------------------------------------------ cliques
document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-link-senha], [data-ativar], [data-apagar-funcao], #copiar-link");
  if (!b) return;
  try {
    if (b.id === "copiar-link") {
      const v = $("#link-valor");
      v.select();
      try { await navigator.clipboard.writeText(v.value); } catch { document.execCommand("copy"); }
      b.textContent = "Copiado ✓";
      return;
    }
    if (b.dataset.linkSenha) {
      b.disabled = true;
      const d = await post("/api/admin/usuarios/" + b.dataset.linkSenha + "/link");
      mostrarLink(d.link, b.dataset.email);
      $("#link-gerado").scrollIntoView({ behavior: "smooth", block: "center" });
      b.disabled = false;
      return;
    }
    if (b.dataset.ativar) {
      const ativo = b.dataset.ativo === "1";
      if (!confirm(ativo ? "Desativar este usuário? Ele perde o acesso na hora." : "Reativar este usuário?")) return;
      await put("/api/admin/usuarios/" + b.dataset.ativar, { ativo: !ativo });
      return renderUsuarios();
    }
    if (b.dataset.apagarFuncao) {
      if (!confirm("Apagar esta função?")) return;
      await del("/api/admin/funcoes/" + b.dataset.apagarFuncao);
      return renderFuncoes();
    }
  } catch (e) { erro(e); b.disabled = false; }
});
