// Telas de administração: usuários e funções. Só para quem tem função de administrador.

import { idDaFuncao, linkDeSenha, MODULOS, type Quem, supabaseAdmin } from "./auth.ts";
import type { storeStub } from "./store.ts";
import type { Env } from "./tipos.ts";

type Store = ReturnType<typeof storeStub>;
type UsuarioSb = { id: string; email?: string; last_sign_in_at?: string | null; email_confirmed_at?: string | null; banned_until?: string | null };

const json = (dados: unknown, status = 200) =>
  new Response(JSON.stringify(dados), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const falha = (msg: string, status = 400) => json({ erro: msg }, status);

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const limpar = (s: unknown, max: number) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, max);

/** Página de retorno do link de senha (precisa estar em Redirect URLs no Supabase). */
const retorno = (env: Env) => `${env.PAINEL_URL}/?senha=1`;

async function usuariosDoSupabase(env: Env): Promise<UsuarioSb[]> {
  const d = await supabaseAdmin<{ users: UsuarioSb[] }>(env, "GET", "/admin/users?per_page=1000");
  return d.users ?? [];
}

function validarModulos(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const m = [...new Set(v.map(String))];
  return m.every((x) => (MODULOS as readonly string[]).includes(x)) ? m : null;
}

export async function rotaAdmin(req: Request, env: Env, url: URL, quem: Quem, store: Store): Promise<Response | null> {
  const p = url.pathname;
  const corpo = async () => { try { return (await req.json()) as Record<string, unknown>; } catch { return {}; } };

  // ------------------------------------------------------------------ funções
  if (req.method === "GET" && p === "/api/admin/funcoes") {
    return json({ funcoes: await store.listarFuncoes(), modulos: MODULOS });
  }
  if (req.method === "POST" && p === "/api/admin/funcoes") {
    const b = await corpo();
    const nome = limpar(b.nome, 40);
    const id = idDaFuncao(nome);
    const modulos = validarModulos(b.modulos);
    if (nome.length < 2 || !id) return falha("Informe o nome da função (2 a 40 caracteres).");
    if (!modulos) return falha("Módulos inválidos.");
    if (await store.funcao(id)) return falha(`Já existe a função "${nome}".`, 409);
    await store.salvarFuncao({ id, nome, modulos, admin: b.admin === true });
    await store.log("info", null, `função criada: ${nome} (${b.admin === true ? "administrador" : modulos.join(", ") || "sem módulos"}) por ${quem.email}`);
    return json({ funcao: await store.funcao(id) });
  }
  let r = p.match(/^\/api\/admin\/funcoes\/([a-z0-9-]{1,40})$/);
  if (r && req.method === "PUT") {
    const atual = await store.funcao(r[1]);
    if (!atual) return falha("Função não encontrada.", 404);
    const b = await corpo();
    const nome = limpar(b.nome ?? atual.nome, 40);
    const modulos = validarModulos(b.modulos ?? atual.modulos);
    if (nome.length < 2 || !modulos) return falha("Nome ou módulos inválidos.");
    const admin = atual.id === "administrador" ? true : b.admin === undefined ? atual.admin : b.admin === true;
    await store.salvarFuncao({ id: atual.id, nome, modulos, admin });
    if ((await store.adminsAtivos()) < 1) { await store.salvarFuncao(atual); return falha("Precisa sobrar pelo menos 1 administrador ativo."); }
    await store.log("info", null, `função alterada: ${nome} (${admin ? "administrador" : modulos.join(", ") || "sem módulos"}) por ${quem.email}`);
    return json({ funcao: await store.funcao(atual.id) });
  }
  if (r && req.method === "DELETE") {
    const atual = await store.funcao(r[1]);
    if (!atual) return falha("Função não encontrada.", 404);
    if (atual.id === "administrador") return falha("A função Administrador não pode ser apagada.");
    if ((await store.listarUsuarios()).some((u) => u.funcao === atual.id)) return falha("Há usuários com essa função: troque a função deles antes.");
    await store.removerFuncao(atual.id);
    await store.log("info", null, `função apagada: ${atual.nome} por ${quem.email}`);
    return json({ ok: true });
  }

  // ------------------------------------------------------------------ usuários
  if (req.method === "GET" && p === "/api/admin/usuarios") {
    const [nossos, doSb] = await Promise.all([store.listarUsuarios(), usuariosDoSupabase(env).catch(() => [] as UsuarioSb[])]);
    const porId = new Map(doSb.map((u) => [u.id, u]));
    return json({
      usuarios: nossos.map((u) => ({ ...u, ultimo_login: porId.get(u.id)?.last_sign_in_at ?? null, eu: u.id === quem.id })),
      funcoes: await store.listarFuncoes(),
    });
  }
  if (req.method === "POST" && p === "/api/admin/usuarios") {
    const b = await corpo();
    const email = limpar(b.email, 254).toLowerCase();
    const nome = limpar(b.nome, 80);
    const funcao = String(b.funcao ?? "");
    if (!EMAIL.test(email)) return falha("E-mail inválido.");
    if (nome.length < 2) return falha("Informe o nome.");
    if (!(await store.funcao(funcao))) return falha("Escolha uma função.");
    if ((await store.listarUsuarios()).some((u) => u.email === email)) return falha("Esse e-mail já está cadastrado no SkyHub.", 409);
    // Reaproveita a conta do Supabase se já existir (ex.: criada pelo painel do Supabase).
    let sb = (await usuariosDoSupabase(env)).find((u) => (u.email ?? "").toLowerCase() === email);
    if (!sb) sb = await supabaseAdmin<UsuarioSb>(env, "POST", "/admin/users", { email, email_confirm: true, user_metadata: { nome } });
    if (!sb?.id) return falha("O Supabase não devolveu o usuário criado.", 502);
    await store.salvarUsuario({ id: sb.id, email, nome, funcao, ativo: true });
    await store.log("info", null, `usuário criado: ${email} (${funcao}) por ${quem.email}`);
    const link = await linkDeSenha(env, email, retorno(env)).catch((e) => `ERRO: ${(e as Error).message}`);
    return json({ usuario: await store.usuario(sb.id), link });
  }
  r = p.match(/^\/api\/admin\/usuarios\/([0-9a-f-]{36})$/);
  if (r && req.method === "PUT") {
    const atual = await store.usuario(r[1]);
    if (!atual) return falha("Usuário não encontrado.", 404);
    const b = await corpo();
    const novo = {
      ...atual,
      nome: b.nome === undefined ? atual.nome : limpar(b.nome, 80),
      funcao: b.funcao === undefined ? atual.funcao : String(b.funcao),
      ativo: b.ativo === undefined ? atual.ativo : b.ativo === true,
    };
    if (novo.nome.length < 2) return falha("Informe o nome.");
    if (!(await store.funcao(novo.funcao))) return falha("Função inexistente.");
    if (atual.id === quem.id && !novo.ativo) return falha("Você não pode desativar o próprio acesso.");
    await store.salvarUsuario(novo);
    if ((await store.adminsAtivos()) < 1) { await store.salvarUsuario(atual); return falha("Precisa sobrar pelo menos 1 administrador ativo."); }
    // Desativado: além do SkyHub negar na hora, o Supabase bloqueia novos logins.
    if (atual.ativo !== novo.ativo) {
      await supabaseAdmin(env, "PUT", `/admin/users/${atual.id}`, { ban_duration: novo.ativo ? "none" : "876000h" });
    }
    await store.log("info", null, `usuário alterado: ${novo.email} (função ${novo.funcao}, ${novo.ativo ? "ativo" : "desativado"}) por ${quem.email}`);
    return json({ usuario: await store.usuario(atual.id) });
  }
  r = p.match(/^\/api\/admin\/usuarios\/([0-9a-f-]{36})\/link$/);
  if (r && req.method === "POST") {
    const atual = await store.usuario(r[1]);
    if (!atual) return falha("Usuário não encontrado.", 404);
    const link = await linkDeSenha(env, atual.email, retorno(env));
    await store.log("info", null, `link de senha gerado para ${atual.email} por ${quem.email}`);
    return json({ link });
  }
  return null;
}
