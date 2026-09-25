// Casamento SKU → ficha: cada caso abaixo foi um casamento errado (ou perdido) real.
// Paridade completa com o casar_fichas.py foi medida à parte em 25/09/2026: 897/897 SKUs
// iguais (mesmas fichas, mesma ordem) contra o pool de 11.253 fichas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatas, capNorm, chaveDeCor, corBate, faltaAtributo, grauMl, modeloBate, tituloModelo } from "../src/casamento.ts";

test("qualificadores e rede separam aparelhos com o mesmo nome", () => {
  assert.equal(modeloBate("SAMSUNG GALAXY S20", "Samsung Galaxy S20+ 128 GB cosmic gray"), false, "S20 ≠ S20+");
  assert.equal(modeloBate("SAMSUNG GALAXY A14 5G", "Samsung Galaxy A14 4G 128 GB preto"), false, "A14 5G ≠ 4G");
  assert.equal(modeloBate("SAMSUNG GALAXY J7 PRIME", "Samsung Galaxy J7 Prime 2 TV 32 GB preto"), false, "J7 Prime ≠ Prime 2 TV");
  assert.equal(modeloBate("APPLE IPHONE X", "Apple iPad X 64 GB"), false, "iPhone ≠ iPad");
  assert.equal(modeloBate("SAMSUNG GALAXY S23", "Samsung Galaxy S23 128 GB preto 8 GB RAM", "SAMSUNG", "Samsung"), true);
});

test("cor: sinônimo batizado, hífen não-separável, titânio sem genérico e acento perdido", () => {
  assert.equal(corBate("PRETO", "iPhone 14 (128 GB) - Meia‑noite - Bom", "Meia‑noite"), true, "Meia-noite com U+2011");
  assert.equal(corBate("TITANIO PRETO", "Galaxy S24 Ultra 256 GB titânio-azul", "Titânio-azul"), false);
  assert.equal(corBate("TITANIO PRETO", "Galaxy S24 Ultra 256 GB titânio preto", "Titânio preto"), true);
  assert.equal(chaveDeCor("CINZA TIT¿NIO"), "CINZA TITANIO");
});

test("título sem capacidade, cor e grau; capacidade e grau normalizados", () => {
  assert.equal(tituloModelo("SAMSUNG GALAXY S23 128GB PRETO - EXCELENTE", "PRETO"), "SAMSUNG GALAXY S23");
  assert.equal(capNorm("128GB"), "128 GB");
  assert.equal(capNorm("1 tb"), "1 TB");
  assert.equal(grauMl("MUITO BOM"), "Bom");
  assert.equal(grauMl("ACEITÁVEL"), "Aceitável");
  assert.equal(grauMl("OUTLET"), null);
});

test("candidatas: exige capacidade e grau iguais e ordena pela cor escrita igual", () => {
  const sku = { sku: "CEL5044", produto: "SAMSUNG GALAXY S23 128GB PRETO - EXCELENTE", marca: "SAMSUNG", cor: "PRETO", capacidade: "128GB", qualidade: "EXCELENTE" };
  const f = (pdp: string, extra: Record<string, string>) => ({ pdp, nome: "Samsung Galaxy S23 128 GB preto 8 GB RAM - Excelente (Recondicionado)", grau: "Excelente", cor: "Preto", capacidade: "128 GB", marca: "Samsung", status: "active", ...extra });
  const lista = candidatas(sku, [
    f("MLB2000000003", { cor: "Phantom black" }),
    f("MLB2000000002", {}),
    f("MLB2000000001", { capacidade: "256 GB" }),
    f("MLB2000000004", { grau: "Bom" }),
    f("MLB2000000005", { status: "closed" }),
  ]);
  assert.deepEqual(lista.map((x) => x.pdp), ["MLB2000000002", "MLB2000000003"]);
  assert.equal(faltaAtributo({ ...sku, qualidade: "OUTLET" }), 'grau "OUTLET" sem equivalente no ML');
});
