#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
copiar_secrets.py — copia, um por vez, os secrets do skyhub do cofre do Windows
para a área de transferência, para colar no painel da Cloudflare.

Nada é impresso na tela nem gravado em arquivo: cada valor vai direto para o
clipboard (comando `clip` do Windows) e é apagado dele no fim.

    python scripts\\copiar_secrets.py

Cloudflare: Workers & Pages → skyhub → Settings → Variables and Secrets → Add →
tipo "Secret", nome exatamente como o script mostra, cole (Ctrl+V), salve.

ADMIN_TOKEN: se ainda não existir no cofre (SKYHUB_ADMIN_TOKEN), é gerado aqui
(32 bytes aleatórios) e gravado no cofre antes de copiar.
"""

import secrets
import subprocess
import sys

import keyring

SERVICO = "fi-ecommerce"

# nome do secret no Worker -> chave no cofre
MAPA = [
    ("MELI_CLIENT_ID", "MELI_CLIENT_ID"),
    ("MELI_CLIENT_SECRET", "MELI_CLIENT_SECRET"),
    ("SANKHYA_CLIENT_ID", "SANKHYA_SKYLINE_CLIENT_ID"),
    ("SANKHYA_CLIENT_SECRET", "SANKHYA_SKYLINE_CLIENT_SECRET"),
    ("SANKHYA_XTOKEN", "SANKHYA_SKYLINE_XTOKEN"),
    ("ADMIN_TOKEN", "SKYHUB_ADMIN_TOKEN"),
]


def copiar(valor: str) -> None:
    subprocess.run("clip", input=valor.encode("utf-16-le"), check=True, shell=True)


def main() -> int:
    if not keyring.get_password(SERVICO, "SKYHUB_ADMIN_TOKEN"):
        keyring.set_password(SERVICO, "SKYHUB_ADMIN_TOKEN", secrets.token_urlsafe(32))
        print("SKYHUB_ADMIN_TOKEN gerado e gravado no cofre.\n")

    faltando = [c for _, c in MAPA if not (keyring.get_password(SERVICO, c) or "").strip()]
    if faltando:
        print("ERRO: chaves ausentes no cofre:", ", ".join(faltando))
        return 1

    for i, (nome, chave) in enumerate(MAPA, 1):
        copiar(keyring.get_password(SERVICO, chave).strip())
        input(f"[{i}/{len(MAPA)}] {nome} copiado. Cole na Cloudflare e tecle Enter...")

    copiar(" ")  # limpa o clipboard
    print("\nPronto. Clipboard limpo. Depois de salvar, avise para semear o token.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
