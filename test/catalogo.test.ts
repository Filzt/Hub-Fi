// Produtos por SKU com a situação por canal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { montarCatalogo, situacaoMl } from "../src/catalogo.ts";
import { REGUA_PRECO } from "../src/sync.ts";

const an = (item_id: string, sku: string, status: string, sub_status = "", qtd_ml = 1, preco_ml: number | null = 100) =>
  ({ item_id, sku, status, sub_status, qtd_ml, preco_ml, listing_type: "gold_special" });

test("situação no ML: um ativo basta; pausado por vocês vem antes de sem estoque", () => {
  assert.equal(situacaoMl([]), "nao_anunciado");
  assert.equal(situacaoMl([an("1", "A", "paused", "out_of_stock"), an("2", "A", "active")]), "ativo");
  assert.equal(situacaoMl([an("1", "A", "paused", "out_of_stock"), an("2", "A", "paused", "paused_by_seller")]), "pausado");
  assert.equal(situacaoMl([an("1", "A", "paused", "out_of_stock")]), "sem_estoque");
  assert.equal(situacaoMl([an("1", "A", "under_review")]), "inativo");
});

test("junta anúncios por SKU, inclui SKU com saldo sem anúncio e ignora encerrado", () => {
  const erp = new Map([["CEL1", { disp: 3, ativo: true, preco_loja: 1000, produto: "IPHONE 13" }]]);
  const lista = montarCatalogo(
    [an("MLB1", "CEL1", "active", "", 3, 1193.6), an("MLB2", "CEL1", "paused", "paused_by_seller", 0), an("MLB3", "CEL9", "closed")],
    erp, [{ sku: "CEL2", produto: "GALAXY S22", disp: 2, preco_loja: 900 }, { sku: "CEL1", produto: "outro nome", disp: 9, preco_loja: 1 }], REGUA_PRECO,
  );
  assert.deepEqual(lista.map((p) => p.sku), ["CEL1", "CEL2"]);
  const [c1, c2] = lista;
  assert.equal(c1.produto, "IPHONE 13");
  assert.equal(c1.disp, 3, "o snapshot da rodada de estoque vale sobre a lista da publicação");
  assert.equal(c1.canais.ml.situacao, "ativo");
  assert.equal(c1.canais.ml.anuncios.length, 2);
  assert.equal(c1.canais.ml.anuncios[1].div_qtd, false, "pausado por vocês não é divergência de estoque");
  assert.equal(c2.canais.ml.situacao, "nao_anunciado");
  assert.equal(c2.disp, 2);
});
