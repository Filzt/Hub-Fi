#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
guardar_telegram.py: guarda no cofre do Windows (keyring "fi-ecommerce") a chave do robô do
Telegram que manda os avisos do skyhub-vigia. A chave não aparece na tela e não passa pelo chat.

Antes de rodar:
  1. No Telegram, fale com @BotFather → /newbot → escolha nome e usuário (termina em "bot").
  2. Abra a conversa com o SEU robô novo e mande /start (sem isso ele não pode te escrever).

    python scripts\\guardar_telegram.py

Grava:
  - TELEGRAM_BOT_TOKEN: chave do robô (o BotFather mostra ao criar);
  - TELEGRAM_CHAT_ID: a sua conversa com o robô, achada pela mensagem /start.
No fim manda uma mensagem de teste. Nada é gravado se a chave for recusada ou se o /start não aparecer.
Doc: core.telegram.org/bots/api (getMe, getUpdates, sendMessage), lida em 26/09/2026.
"""
import getpass
import json
import sys
import urllib.error
import urllib.request

import keyring

SERVICO = "fi-ecommerce"


def chamar(token: str, metodo: str, dados: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{metodo}",
        data=json.dumps(dados).encode() if dados is not None else None,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"ok": False, "description": f"HTTP {e.code}"}


def main() -> int:
    token = getpass.getpass("Cole a chave do robô (não aparece na tela) e aperte Enter: ").strip()
    if ":" not in token:
        print("Isso não parece a chave do BotFather (formato número:letras). Nada foi gravado.")
        return 1
    eu = chamar(token, "getMe")
    if not eu.get("ok"):
        print(f"O Telegram recusou a chave ({eu.get('description', 'sem motivo')}). Nada foi gravado.")
        return 1
    robo = eu["result"].get("username")
    upd = chamar(token, "getUpdates")
    chats = [
        u["message"]["chat"] for u in upd.get("result", [])
        if u.get("message", {}).get("chat", {}).get("type") == "private"
    ]
    if not chats:
        print(f"Não achei a sua mensagem. Abra a conversa com @{robo}, mande /start e rode de novo. Nada foi gravado.")
        return 1
    chat = chats[-1]
    teste = chamar(token, "sendMessage", {
        "chat_id": chat["id"],
        "text": "SkyHub: teste. Se você está lendo isto, os avisos do SkyHub chegam aqui.",
    })
    if not teste.get("ok"):
        print(f"Não consegui mandar o teste ({teste.get('description')}). Nada foi gravado.")
        return 1
    keyring.set_password(SERVICO, "TELEGRAM_BOT_TOKEN", token)
    keyring.set_password(SERVICO, "TELEGRAM_CHAT_ID", str(chat["id"]))
    print(f"Pronto: robô @{robo}, conversa com {chat.get('first_name', '?')}. Mandei um teste no Telegram. Guardado no cofre.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
