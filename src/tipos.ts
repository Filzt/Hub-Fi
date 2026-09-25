import type { MeliToken } from "./meli.ts";
import type { Store } from "./store.ts";

export interface Env {
  MODO: string;
  XML_MODO: string;
  CANCELAMENTO_MODO: string;
  ESTOQUE_MODO: string; // sombra (só planeja) | automatico (aplica quantidade no ML)
  PRECO_MODO: string; // sombra | automatico (aplica preço no ML) // desligado | manual (só pelo painel) | automatico (ao receber o cancelamento do ML) // manual (só pelo painel) | automatico (cron envia)
  MELI_API: string;
  MELI_USER_ID: string;
  SANKHYA_API: string;
  SUPABASE_URL: string; // login do painel (Supabase Auth)
  SUPABASE_PUBLISHABLE_KEY: string; // pública: vai para o navegador
  ADMIN_INICIAL: string; // e-mail que entra como Administrador no 1º acesso
  PAINEL_URL: string; // retorno do link de senha

  MELI_CLIENT_ID: string;
  MELI_CLIENT_SECRET: string;
  SANKHYA_CLIENT_ID: string;
  SANKHYA_CLIENT_SECRET: string;
  SANKHYA_XTOKEN: string;
  ADMIN_TOKEN: string;
  SUPABASE_SECRET_KEY: string; // só no Worker: cria usuário e gera link de senha

  MELI_TOKEN: DurableObjectNamespace<MeliToken>;
  STORE: DurableObjectNamespace<Store>;
}

/** Erro que vale tentar de novo (5xx, 429, timeout, rede). */
export class ErroTemporario extends Error {
  name = "ErroTemporario";
}

/** Erro que não se resolve sozinho (4xx de validação, permissão, dado faltando). */
export class ErroDefinitivo extends Error {
  name = "ErroDefinitivo";
}
