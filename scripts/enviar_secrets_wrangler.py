#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
enviar_secrets_wrangler.py — grava os 6 secrets do skyhub direto do cofre do
Windows no Worker, via `wrangler secret put`, sem copiar/colar e sem login
interativo na Cloudflare.

Usa um token de API da Cloudflare (criado em outro PC, onde há acesso à conta):
    Cloudflare → My Profile → API Tokens → Create Token → modelo
    "Edit Cloudflare Workers" → Account Resources: só a conta do skyhub.
Na 1ª execução o script pede o token (entrada oculta) e o Account ID e grava
os dois no cofre (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID).

    python scripts\\enviar_secrets_wrangler.py

Depois de confirmar que funcionou, revogue o token na Cloudflare se não for
mais usá-lo, e apague do cofre.
"""

import getpass
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

import keyring

SERVICO = "fi-ecommerce"
RAIZ = Path(__file__).resolve().parents[1]
URL_WORKER = (keyring.get_password(SERVICO, "SKYHUB_URL") or "").strip().rstrip("/")  # do cofre, não fixo no código

MAPA = [  # secret no Worker -> chave no cofre
    ("MELI_CLIENT_ID", "MELI_CLIENT_ID"),
    ("MELI_CLIENT_SECRET", "MELI_CLIENT_SECRET"),
    ("SANKHYA_CLIENT_ID", "SANKHYA_SKYLINE_CLIENT_ID"),
    ("SANKHYA_CLIENT_SECRET", "SANKHYA_SKYLINE_CLIENT_SECRET"),
    ("SANKHYA_XTOKEN", "SANKHYA_SKYLINE_XTOKEN"),
    ("ADMIN_TOKEN", "SKYHUB_ADMIN_TOKEN"),
    ("SUPABASE_SECRET_KEY", "SUPABASE_SKYHUB_SECRET_KEY"),  # login do painel (25/09/2026)
    ("WEBHOOK_SECRET", "SKYHUB_WEBHOOK_SECRET"),  # segmento secreto da URL do webhook (auditoria F1)
    ("SCRIPTS_TOKEN", "SKYHUB_SCRIPTS_TOKEN"),  # só /api/meli/access-token (auditoria F2)
]


def do_cofre_ou_pergunta(chave: str, rotulo: str, oculto: bool) -> str:
    v = (keyring.get_password(SERVICO, chave) or "").strip()
    if v:
        return v
    v = (getpass.getpass if oculto else input)(f"{rotulo}: ").strip()
    if not v:
        sys.exit(f"ERRO: {rotulo} vazio.")
    keyring.set_password(SERVICO, chave, v)
    print(f"  {chave} gravado no cofre.")
    return v


def main() -> int:
    env = dict(os.environ)
    env["CLOUDFLARE_API_TOKEN"] = do_cofre_ou_pergunta(
        "CLOUDFLARE_API_TOKEN", "Token de API da Cloudflare (não aparece ao digitar)", True)
    env["CLOUDFLARE_ACCOUNT_ID"] = do_cofre_ou_pergunta(
        "CLOUDFLARE_ACCOUNT_ID", "Account ID da Cloudflare", False)

    so = set(sys.argv[1:])
    mapa = [(n, c) for n, c in MAPA if not so or n in so]
    if so - {n for n, _ in MAPA}:
        sys.exit("ERRO: secret desconhecido: " + ", ".join(sorted(so - {n for n, _ in MAPA})))
    faltando = [c for _, c in mapa if not (keyring.get_password(SERVICO, c) or "").strip()]
    if faltando:
        sys.exit("ERRO: chaves ausentes no cofre: " + ", ".join(faltando)
                 + " (ADMIN_TOKEN: rode scripts\\copiar_secrets.py uma vez para gerar)")

    npx = "npx.cmd" if os.name == "nt" else "npx"  # evita o shim .ps1 (ExecutionPolicy)
    for nome, chave in mapa:
        valor = keyring.get_password(SERVICO, chave).strip()
        r = subprocess.run([npx, "wrangler", "secret", "put", nome], cwd=RAIZ, env=env,
                           input=valor, text=True, capture_output=True)
        ok = r.returncode == 0
        print(f"  {nome}: {'ok' if ok else 'FALHOU'}")
        if not ok:
            # stderr do wrangler não contém o valor do secret
            print("   ", (r.stderr or r.stdout).strip()[-400:])
            return 1

    # Diagnóstico com o token de operação (o /config público não lista mais secrets — auditoria F3).
    admin = (keyring.get_password(SERVICO, "SKYHUB_ADMIN_TOKEN") or "").strip()
    req = urllib.request.Request(f"{URL_WORKER}/api/admin/config", headers={
        "User-Agent": "skyhub-secrets", "Authorization": f"Bearer {admin}"})  # UA padrão do urllib leva 403
    with urllib.request.urlopen(req, timeout=30) as resp:
        cfg = json.load(resp)
    print("\nWorker /api/admin/config:", json.dumps(cfg["secrets"]))
    return 0 if all(cfg["secrets"].values()) else 1


if __name__ == "__main__":
    sys.exit(main())
