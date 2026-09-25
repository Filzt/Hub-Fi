// SkyHub — login pelo Supabase Auth (e-mail e senha), "esqueci a senha" e nova senha.
// Carregado antes do app.js. Expõe window.skyAuth; o app.js chama skyAuth.iniciar().
//
// Link de senha (e-mail do "esqueci" ou link gerado pelo administrador) volta em
// /?senha=1#access_token=...&type=recovery (fluxo implícito: funciona mesmo aberto em
// outro navegador, ex.: o link mandado pelo WhatsApp).
"use strict";

window.skyAuth = (() => {
  let cliente = null;
  let aoEntrar = () => {};
  let logado = false;

  const el = (id) => document.getElementById(id);
  const msg = (texto, tipo) => {
    const m = el("login-msg");
    m.textContent = texto || "";
    m.className = "login-msg" + (tipo ? " " + tipo : "");
  };

  /** Mostra uma das 3 caixas: entrar | esqueci | nova. */
  function mostrar(qual, texto, tipo) {
    el("tela-login").hidden = false;
    for (const f of ["entrar", "esqueci", "nova"]) el("form-" + f).hidden = f !== qual;
    el("cancelar-nova").hidden = !(qual === "nova" && logado);
    msg(texto, tipo);
    const foco = { entrar: "login-email", esqueci: "esqueci-email", nova: "nova-senha" }[qual];
    setTimeout(() => el(foco) && el(foco).focus(), 30);
  }
  const esconder = () => { el("tela-login").hidden = true; msg(""); };

  /** Mensagens do Supabase em português, sem revelar se o e-mail existe. */
  function traduzir(e) {
    const t = String((e && (e.message || e.error_description)) || e || "");
    if (/invalid login credentials/i.test(t)) return "E-mail ou senha incorretos.";
    if (/email not confirmed/i.test(t)) return "E-mail ainda não confirmado. Peça um link de senha ao administrador.";
    if (/rate limit|not authorized|over_email_send_rate/i.test(t))
      return "Não foi possível enviar o e-mail agora. Peça ao administrador um link de senha pelo SkyHub.";
    if (/should be different|same.*password/i.test(t)) return "A nova senha precisa ser diferente da atual.";
    if (/password.*(short|at least|weak)/i.test(t)) return "Senha fraca: use pelo menos 8 caracteres, com letras e números.";
    if (/banned|user is banned/i.test(t)) return "Seu acesso está desativado. Fale com o administrador.";
    if (/failed to fetch|network/i.test(t)) return "Sem conexão com o servidor de login. Tente de novo.";
    return t || "Não deu certo. Tente de novo.";
  }

  function limparUrl() {
    // Tira o token e o ?senha=1 da barra de endereço; mantém a rota do painel (#expedicao...).
    const rotaPainel = /access_token=|error=|type=recovery/.test(location.hash) ? "" : location.hash;
    history.replaceState(null, "", location.pathname + rotaPainel);
  }

  async function iniciar(callback) {
    aoEntrar = callback;
    const erroLink = new URLSearchParams(location.hash.slice(1)).get("error_description");
    let recuperacao = /type=recovery/.test(location.hash) || new URLSearchParams(location.search).has("senha");
    let cfg;
    try { cfg = await fetch("/config", { cache: "no-store" }).then((r) => r.json()); } catch { cfg = null; }
    if (!cfg || !cfg.supabase || !cfg.supabase.url || !window.supabase) {
      return mostrar("entrar", "Login indisponível agora (configuração não carregou). Recarregue a página.", "erro");
    }
    cliente = window.supabase.createClient(cfg.supabase.url, cfg.supabase.chavePublicavel, {
      auth: { flowType: "implicit", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true, storageKey: "skyhub-auth" },
    });
    cliente.auth.onAuthStateChange((evento) => {
      if (evento === "PASSWORD_RECOVERY") { recuperacao = true; mostrar("nova", "Defina sua senha para entrar."); }
      if (evento === "SIGNED_OUT") { logado = false; mostrar("entrar"); }
    });
    const { data } = await cliente.auth.getSession();
    limparUrl();
    if (erroLink) return mostrar("entrar", "Esse link de senha não vale mais (" + erroLink + "). Peça outro ao administrador.", "erro");
    if (data.session && recuperacao) return mostrar("nova", "Defina sua senha para entrar.");
    if (data.session) { logado = true; esconder(); return aoEntrar(); }
    mostrar("entrar");
  }

  async function token() {
    if (!cliente) return "";
    const { data } = await cliente.auth.getSession();
    return (data.session && data.session.access_token) || "";
  }

  async function renovar() {
    if (!cliente) return false;
    const { data, error } = await cliente.auth.refreshSession();
    return !error && !!(data && data.session);
  }

  async function sair(motivo) {
    logado = false;
    try { if (cliente) await cliente.auth.signOut(); } catch { /* sai localmente mesmo assim */ }
    mostrar("entrar", motivo || "", motivo ? "erro" : "");
  }

  function trocarSenha() { mostrar("nova", "Escolha a nova senha."); }

  /**
   * Confere a senha atual direto no Supabase (a senha não passa pelo SkyHub). Renova a
   * sessão com a marca de "senha digitada agora", que o Worker exige para trocar o e-mail.
   * Devolve null se deu certo, ou a mensagem de erro.
   */
  async function confirmarSenha(senha) {
    if (!cliente) return "Login indisponível agora.";
    const { data } = await cliente.auth.getSession();
    const email = data.session && data.session.user && data.session.user.email;
    if (!email) return "Sua sessão expirou. Entre de novo.";
    const { error } = await cliente.auth.signInWithPassword({ email, password: senha });
    return error ? (/invalid login credentials/i.test(error.message) ? "Senha atual incorreta." : traduzir(error)) : null;
  }

  // ------------------------------------------------------------------ formulários
  document.addEventListener("submit", async (ev) => {
    const f = ev.target;
    if (!f.id || !f.id.startsWith("form-")) return;
    ev.preventDefault();
    const botao = f.querySelector("button[type=submit]");
    botao.disabled = true;
    try {
      if (f.id === "form-entrar") {
        msg("Entrando…");
        const { error } = await cliente.auth.signInWithPassword({ email: el("login-email").value.trim(), password: el("login-senha").value });
        if (error) return msg(traduzir(error), "erro");
        el("login-senha").value = "";
        logado = true; esconder(); await aoEntrar();
      } else if (f.id === "form-esqueci") {
        const email = el("esqueci-email").value.trim();
        const { error } = await cliente.auth.resetPasswordForEmail(email, { redirectTo: location.origin + "/?senha=1" });
        if (error) return msg(traduzir(error), "erro");
        mostrar("entrar", "Se esse e-mail tiver acesso, o link de senha chega em instantes. Não chegou? Peça ao administrador um link pelo SkyHub.", "ok");
      } else if (f.id === "form-nova") {
        const s1 = el("nova-senha").value, s2 = el("nova-senha2").value;
        if (s1.length < 8 || !/[a-z]/i.test(s1) || !/\d/.test(s1)) return msg("Use pelo menos 8 caracteres, com letras e números.", "erro");
        if (s1 !== s2) return msg("As duas senhas não são iguais.", "erro");
        const { error } = await cliente.auth.updateUser({ password: s1 });
        if (error) return msg(traduzir(error), "erro");
        el("nova-senha").value = el("nova-senha2").value = "";
        const jaEstava = logado;
        logado = true; esconder();
        if (!jaEstava) await aoEntrar();
        else if (window.avisar) window.avisar("Senha alterada.");
      }
    } catch (e) { msg(traduzir(e), "erro"); } finally { botao.disabled = false; }
  });

  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("#ir-esqueci, #voltar-entrar, #cancelar-nova");
    if (!b) return;
    ev.preventDefault();
    if (b.id === "ir-esqueci") { el("esqueci-email").value = el("login-email").value; mostrar("esqueci"); }
    if (b.id === "voltar-entrar") mostrar("entrar");
    if (b.id === "cancelar-nova") esconder();
  });

  return { iniciar, token, renovar, sair, trocarSenha, confirmarSenha };
})();
