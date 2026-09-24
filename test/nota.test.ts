// node --test test/   (Node 22.6+ remove os tipos sozinho)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compararComBase,
  consolidar,
  dataSaoPaulo,
  freteVendedorCentavos,
  montarNota,
  montarParceiro,
  separarLogradouro,
  siglaUf,
  skuValido,
  type OrderML,
} from "../src/nota.ts";

// Pedidos ILUSTRATIVOS — formato conforme a doc de /orders, valores inventados.
const order = (id: string, sku: string, preco: number, fee: number, extra: Partial<OrderML> = {}): OrderML => ({
  id,
  status: "paid",
  pack_id: null,
  date_created: "2026-09-24T01:30:00.000-04:00",
  shipping: { id: 44000000001 },
  buyer: { billing_info: { id: "BI-1" } },
  order_items: [{ item: { id: "MLB1", seller_sku: sku }, quantity: 1, unit_price: preco, sale_fee: fee }],
  ...extra,
});

test("DTNEG usa o fuso de São Paulo", () => {
  // 01:30 em -04:00 = 02:30 em São Paulo, mesmo dia
  assert.equal(dataSaoPaulo("2026-09-24T01:30:00.000-04:00"), "24/09/2026");
  // 23:30 UTC do dia 24 = 20:30 em SP, ainda dia 24
  assert.equal(dataSaoPaulo("2026-09-24T23:30:00.000Z"), "24/09/2026");
  // 02:00 UTC do dia 25 = 23:00 em SP do dia 24
  assert.equal(dataSaoPaulo("2026-09-25T02:00:00.000Z"), "24/09/2026");
});

test("order avulsa: chave é o order_id e comissão vem do sale_fee", () => {
  const p = consolidar([order("2000000000000001", "CEL5288", 3867.77, 425.45)]);
  assert.equal(p.chave, "2000000000000001");
  assert.equal(p.totalCentavos, 386777);
  assert.equal(p.comissaoCentavos, 42545);
  assert.deepEqual(p.alertas, []);
});

test("pack: itens de todas as orders no mesmo pedido, chave é o pack_id", () => {
  const p = consolidar([
    order("2000000000000001", "CEL5288", 1000, 110, { pack_id: 2000009999999999 }),
    order("2000000000000002", "CEL4669", 500.1, 55.01, { pack_id: 2000009999999999 }),
  ]);
  assert.equal(p.chave, "2000009999999999");
  assert.equal(p.itens.length, 2);
  assert.equal(p.totalCentavos, 150010);
  assert.equal(p.comissaoCentavos, 16501);
});

test("alerta quando falta SELLER_SKU; comissão multiplica sale_fee pela quantidade", () => {
  const o = order("1", "", 744.16, 81.86);
  o.order_items[0].quantity = 2;
  const p = consolidar([o]);
  assert.equal(p.alertas.length, 1);
  assert.equal(p.comissaoCentavos, 16372);
  assert.equal(p.totalCentavos, 148832);
});

test("SKU com aspas ou espaço é recusado (proteção do SQL)", () => {
  assert.ok(skuValido("CEL5288"));
  assert.ok(!skuValido("CEL' OR 1=1--"));
  assert.ok(!skuValido("CEL 1"));
});

test("frete do vendedor sai de senders[].cost do nosso user_id", () => {
  const costs = { senders: [{ user_id: 999, cost: 5 }, { user_id: 3474041384, cost: 29.34 }] };
  assert.equal(freteVendedorCentavos(costs, "3474041384"), 2934);
  assert.equal(freteVendedorCentavos({ senders: [] }, "3474041384"), 0);
});

test("montarNota segue o template da Skyline", () => {
  const n = montarNota({
    codparc: 953,
    dtneg: "24/09/2026",
    observacao: "2000000000000001",
    comissaoCentavos: 42545,
    freteCentavos: 2934,
    itens: [{ codprod: 5388256, quantidade: 1, precoCentavos: 386777 }],
  });
  const cab = n.requestBody.nota.cabecalho as Record<string, { $?: string }>;
  assert.equal(cab.CODTIPOPER.$, "1090");
  assert.equal(cab.CODNAT.$, "1040000");
  assert.equal(cab.CODPARCTRANSP.$, "261");
  assert.equal(cab.TIPFRETE.$, "S");
  assert.equal(cab.OBSERVACAO.$, "2000000000000001");
  assert.equal(cab.AD_VLRCOMISSAO.$, "425.45");
  assert.equal(cab.AD_FRETEMKTP.$, "29.34");
  const it = n.requestBody.nota.itens.item[0];
  assert.equal(it.VLRUNIT.$, "3867.77");
  assert.equal(it.CODPROD.$, "5388256");
  // JSON válido e sem aspas curvas
  assert.ok(!/[“”]/.test(JSON.stringify(n)));
});

test("comparação com a Base aponta divergência de item e comissão", () => {
  const nota = {
    codparc: 953, dtneg: "24/09/2026", observacao: "1", comissaoCentavos: 42545, freteCentavos: 0,
    itens: [{ codprod: 5388256, quantidade: 1, precoCentavos: 386777 }],
  };
  const igual = compararComBase(nota, [{
    NUNOTA: 8891, CODTIPOPER: 1090, OBSERVACAO: "1", VLRNOTA: 3867.77, AD_VLRCOMISSAO: 425.45, CODPARC: 953,
    itens: [{ CODPROD: 5388256, QTDNEG: 1, VLRUNIT: 3867.77 }],
  }]);
  assert.deepEqual(igual, { encontrado: true, nunotas: [8891], divergencias: [] });

  const dif = compararComBase(nota, [{
    NUNOTA: 8891, CODTIPOPER: 1090, OBSERVACAO: "1", VLRNOTA: 3867.77, AD_VLRCOMISSAO: 400, CODPARC: 953,
    itens: [{ CODPROD: 5388256, QTDNEG: 1, VLRUNIT: 3800 }],
  }]);
  assert.equal(dif.divergencias.length, 2);

  assert.equal(compararComBase(nota, []).encontrado, false);
});

// Billing ILUSTRATIVO — formato de /orders/billing-info, dados inventados.
const billing = (extra: Record<string, unknown> = {}) => ({
  name: "Maria", last_name: "da Silva  Souza",
  identification: { type: "CPF", number: "123.456.789-01" },
  address: { street_name: "Rua X", street_number: "46", comment: "Apto 12", zip_code: "15900-000" },
  ...extra,
});
const cep = { CODEND: 1230169, CODBAI: 33248, CODCID: 9720 };

test("parceiro PF no padrão da Base", () => {
  const r = montarParceiro(billing(), cep);
  assert.equal(r.bloqueio, null);
  assert.equal(r.campos!.NOMEPARC, "MARIA DA SILVA SOUZA");
  assert.equal(r.campos!.RAZAOSOCIAL, "Maria da Silva Souza");
  assert.equal(r.campos!.TIPPESSOA, "F");
  assert.equal(r.campos!.CGC_CPF, "12345678901");
  assert.equal(r.campos!.CEP, "15900000");
  assert.equal(r.campos!.CODCID, "9720");
  assert.equal(r.campos!.NUMEND, "46");
  assert.equal(r.campos!.COMPLEMENTO, "Apto 12");
  assert.equal(r.campos!.CLASSIFICMS, "C");
  assert.equal(r.campos!.IDENTINSCESTAD, undefined);
});

test("parceiro: S/N vira SN, número longo vai ao complemento", () => {
  assert.equal(montarParceiro(billing({ address: { street_number: "s/n", zip_code: "15900000" } }), cep).campos!.NUMEND, "SN");
  const r = montarParceiro(billing({ address: { street_number: "1234567", comment: "Casa", zip_code: "15900000" } }), cep);
  assert.equal(r.campos!.NUMEND, "SN");
  assert.equal(r.campos!.COMPLEMENTO, "Nº 1234567 Casa");
  assert.equal(r.alertas.length, 1);
});

test("parceiro PJ com IE; IE longa bloqueia em vez de truncar", () => {
  const pj = { identification: { type: "CNPJ", number: "12.345.678/0001-90" }, taxes: { inscriptions: { state_registration: "123456789012" } } };
  const r = montarParceiro(billing(pj), cep);
  assert.equal(r.campos!.TIPPESSOA, "J");
  assert.equal(r.campos!.IDENTINSCESTAD, "123456789012");
  const longa = { ...pj, taxes: { inscriptions: { state_registration: "12345678901234567" } } };
  assert.match(montarParceiro(billing(longa), cep).bloqueio!, /nunca truncar/);
});

test("parceiro bloqueia sem CEP na TSICEP ou documento inválido", () => {
  assert.match(montarParceiro(billing(), null).bloqueio!, /TSICEP/);
  assert.match(montarParceiro(billing({ identification: { type: "CPF", number: "123" } }), cep).bloqueio!, /documento/);
});

test("o JavaScript do painel é válido (template literal não pode quebrar string)", async () => {
  const { PAINEL_HTML } = await import("../src/painel.ts");
  const js = PAINEL_HTML.split("<script>")[1].split("</script>")[0];
  assert.doesNotThrow(() => new Function(js));
});

test("separa tipo e nome do logradouro", () => {
  assert.deepEqual(separarLogradouro("Avenida Brasil"), { tipo: "Av", nome: "Brasil" });
  assert.deepEqual(separarLogradouro("R. Coronel Godinho"), { tipo: "R", nome: "Coronel Godinho" });
  assert.deepEqual(separarLogradouro("Praça  da Sé"), { tipo: "Pc", nome: "da Sé" });
  assert.deepEqual(separarLogradouro("Coronel Godinho"), { tipo: null, nome: "Coronel Godinho" });
  assert.deepEqual(separarLogradouro("Rua"), { tipo: null, nome: "Rua" });
  assert.equal(siglaUf("BR-MT"), "MT");
  assert.equal(siglaUf("X"), "");
});

test("parceiro com rua a criar: CODEND vazio, bairro/cidade resolvidos", () => {
  const r = montarParceiro(billing(), { CODEND: null, CODBAI: 45993, CODCID: 4442, enderecoNovo: { NOMEEND: "RUA NOVA", TIPO: "R" } });
  assert.equal(r.bloqueio, null);
  assert.equal(r.campos!.CODEND, "");
  assert.equal(r.campos!.CODCID, "4442");
  assert.match(montarParceiro(billing(), { CODEND: null, CODBAI: 6, CODCID: 1 }).bloqueio!, /rua/);
});
