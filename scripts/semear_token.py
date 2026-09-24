#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
semear_token.py — corte do dono do token do Mercado Livre: local -> skyhub.

O refresh_token do ML é de USO ÚNICO. Este script entrega o refresh atual ao
Worker (que o troca e passa a ser o único a renovar) e, só se der certo:
  1. grava SKYHUB_URL no cofre — a partir daí o ml_api.py pede o token ao Worker;
  2. renomeia o arquivo de token local, para ninguém renovar com ele.

    python scripts\\semear_token.py https://skyhub.<conta>.workers.dev          (dry-run)
    python scripts\\semear_token.py https://skyhub.<conta>.workers.dev --enviar

Rollback: apagar SKYHUB_URL do cofre e reautorizar o OAuth
(ml_api.py --trocar-code), porque o refresh antigo foi consumido pelo Worker.
"""

import argparse
import json
import sys
from pathlib import Path

import keyring
import requests

SERVICO = "fi-ecommerce"
ARQ_TOKEN = Path(r"C:\dev\fi-ecommerce\ml_token_catalogo.json")
TIMEOUT = 30


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--enviar", action="store_true", help="executa o corte (sem isso, só confere)")
    a = ap.parse_args()
    url = a.url.rstrip("/")

    admin = keyring.get_password(SERVICO, "SKYHUB_ADMIN_TOKEN")
    if not admin:
        print("ERRO: SKYHUB_ADMIN_TOKEN ausente — rode antes scripts\\copiar_secrets.py")
        return 1
    h = {"Authorization": f"Bearer {admin}"}

    r = requests.get(f"{url}/api/meli/status", headers=h, timeout=TIMEOUT)
    if r.status_code == 401:
        print("ERRO: Worker recusou o ADMIN_TOKEN — o secret ADMIN_TOKEN está cadastrado na Cloudflare?")
        return 1
    r.raise_for_status()
    status = r.json()
    print(f"Worker responde. Token do ML semeado no Worker: {status.get('semeado')}")
    if status.get("semeado"):
        print("Já semeado — nada a fazer. (Para refazer, reautorize o OAuth antes.)")
        return 0

    if not ARQ_TOKEN.exists():
        print(f"ERRO: {ARQ_TOKEN} não existe — já foi migrado ou nunca foi autorizado.")
        return 1
    refresh = json.loads(ARQ_TOKEN.read_text(encoding="utf-8")).get("refresh_token")
    if not refresh:
        print("ERRO: arquivo de token sem refresh_token.")
        return 1

    if not a.enviar:
        print("Dry-run OK: refresh local encontrado, Worker pronto. Rode com --enviar para cortar.")
        return 0

    r = requests.post(f"{url}/api/meli/semear", headers=h, json={"refresh_token": refresh}, timeout=TIMEOUT)
    if r.status_code != 200:
        # Não mexe em nada local: o refresh só é consumido se o ML aceitou a troca.
        print(f"ERRO ao semear (HTTP {r.status_code}): {r.text[:300]}")
        return 1

    keyring.set_password(SERVICO, "SKYHUB_URL", url)
    destino = ARQ_TOKEN.with_name("ml_token_catalogo.migrado-skyhub.json")
    ARQ_TOKEN.rename(destino)
    print(f"Token semeado no Worker. SKYHUB_URL gravado no cofre. Arquivo local -> {destino.name}")

    # Confere o caminho novo: token vindo do Worker lê a conta.
    t = requests.get(f"{url}/api/meli/access-token", headers=h, timeout=TIMEOUT).json()["access_token"]
    me = requests.get("https://api.mercadolibre.com/users/me", timeout=TIMEOUT,
                      headers={"Authorization": f"Bearer {t}"}).json()
    print(f"Teste: /users/me pelo token do Worker -> {me.get('nickname')} ({me.get('id')})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
