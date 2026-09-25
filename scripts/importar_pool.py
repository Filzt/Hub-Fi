#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
importar_pool.py — leva o pool de fichas recondicionadas levantado pelo ml-catalogo
(skyline/projetos/ml-catalogo/2-saidas/11_pool_fichas.csv, ';', utf-8-sig) para o SkyHub,
em lotes de 500, pela rota /api/publicacao/fichas/importar (token do sistema, do cofre).

    python scripts\\importar_pool.py                 (usa o CSV padrão)
    python scripts\\importar_pool.py caminho.csv

Idempotente: a ficha é gravada por pdp (reimportar atualiza). Não chama o Mercado Livre.
"""
import csv
import json
import sys
import urllib.request
from pathlib import Path

import keyring

URL = "https://skyhub.olivera-kaique2004.workers.dev"
PADRAO = Path(r"C:\Users\filip\OneDrive\Área de Trabalho\Fi-Ecommerce\skyline\projetos\ml-catalogo\2-saidas\11_pool_fichas.csv")
CAMPOS = ("pdp", "nome", "grau", "cor", "capacidade", "marca", "modelo", "status", "parent_id", "pdp_tradicional")


def main() -> int:
    arq = Path(sys.argv[1]) if len(sys.argv) > 1 else PADRAO
    token = (keyring.get_password("fi-ecommerce", "SKYHUB_ADMIN_TOKEN") or "").strip()
    if not token:
        sys.exit("ERRO: SKYHUB_ADMIN_TOKEN não está no cofre")
    with arq.open(encoding="utf-8-sig", newline="") as f:
        linhas = [{k: (r.get(k) or "").strip() for k in CAMPOS} for r in csv.DictReader(f, delimiter=";")]
    linhas = [l for l in linhas if l["pdp"].startswith("MLB") and l["nome"]]
    print(f"{arq.name}: {len(linhas)} fichas válidas")
    total = 0
    for i in range(0, len(linhas), 500):
        corpo = json.dumps({"linhas": linhas[i:i + 500]}).encode("utf-8")
        req = urllib.request.Request(f"{URL}/api/publicacao/fichas/importar", data=corpo, method="POST", headers={
            "Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "skyhub-importar-pool"})
        with urllib.request.urlopen(req, timeout=120) as r:
            total += json.load(r)["gravadas"]
        print(f"  {min(i + 500, len(linhas))}/{len(linhas)}")
    print(f"gravadas: {total}")
    return 0 if total == len(linhas) else 1


if __name__ == "__main__":
    sys.exit(main())
