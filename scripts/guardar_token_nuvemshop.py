#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
guardar_token_nuvemshop.py: guarda no cofre do Windows (keyring "fi-ecommerce") o token do
"Aplicativo sob medida" da loja Nuvemshop da Skyline. O token não aparece na tela e não passa pelo chat.

    python scripts\\guardar_token_nuvemshop.py

Grava:
  - NUVEMSHOP_SKYLINE_STORE: id da loja (7853674, skylinemobile.com.br);
  - NUVEMSHOP_SKYLINE_TOKEN: token de acesso. A Nuvemshop mostra uma única vez na criação do app.

Nunca regrave NUVEMSHOP_STORE/NUVEMSHOP_TOKEN: essas são da Skytech e 4 rotinas dependem delas.
Depois de gravar, confere o token com 1 leitura (GET /store) na API e mostra só o nome da loja.
"""
import getpass
import json
import sys
import urllib.error
import urllib.request

import keyring

SERVICO = "fi-ecommerce"
LOJA = "7853674"


def main() -> int:
    token = getpass.getpass("Cole o token da Nuvemshop (não aparece na tela) e aperte Enter: ").strip()
    if len(token) < 20:
        print("Token vazio ou curto demais. Nada foi gravado.")
        return 1
    req = urllib.request.Request(
        f"https://api.nuvemshop.com.br/2025-03/{LOJA}/store",
        headers={"Authorization": f"Bearer {token}", "User-Agent": "SkyHub (filipe@gruposkytech.com.br)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            loja = json.load(r)
    except urllib.error.HTTPError as e:
        print(f"A Nuvemshop recusou o token (HTTP {e.code}). Nada foi gravado. Confira se copiou inteiro e se é da loja Skyline.")
        return 1
    except urllib.error.URLError as e:
        print(f"Sem conexão com a Nuvemshop ({e.reason}). Nada foi gravado.")
        return 1
    nome = loja.get("name", {})
    nome = nome.get("pt") if isinstance(nome, dict) else nome
    keyring.set_password(SERVICO, "NUVEMSHOP_SKYLINE_STORE", LOJA)
    keyring.set_password(SERVICO, "NUVEMSHOP_SKYLINE_TOKEN", token)
    print(f"Token válido para a loja \"{nome}\" ({loja.get('original_domain') or LOJA}). Guardado no cofre.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
