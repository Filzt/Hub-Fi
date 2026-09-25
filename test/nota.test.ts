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

test("o JavaScript do painel (app.js, login.js, admin.js) é válido", async () => {
  const { readFileSync } = await import("node:fs");
  for (const arq of ["app.js", "login.js", "admin.js"]) {
    const js = readFileSync(new URL("../public/" + arq, import.meta.url), "utf8");
    assert.doesNotThrow(() => new Function(js), arq);
  }
});

test("fases do pedido na esteira", async () => {
  const { fase } = await import("../src/fluxo.ts");
  const base = { situacao: "pronto", gravacao: null, nunota: null, nf_status: null, nunota_nf: null, envio_status: null, envio_substatus: null };
  assert.equal(fase(base), "novo");
  assert.equal(fase({ ...base, situacao: "no_erp", gravacao: "gravado", nunota: 1 }), "erp");
  assert.equal(fase({ ...base, situacao: "no_erp", nunota: 1, nunota_nf: 2, nf_status: "aguardando_ml" }), "faturado");
  assert.equal(fase({ ...base, situacao: "no_erp", nunota_nf: 2, nf_status: "enviado", envio_status: "ready_to_ship", envio_substatus: "ready_to_print" }), "nf_ml");
  assert.equal(fase({ ...base, situacao: "no_erp", nunota_nf: 2, nf_status: "enviado", envio_status: "ready_to_ship", envio_substatus: "printed" }), "etiqueta");
  assert.equal(fase({ ...base, situacao: "no_erp", nunota_nf: 2, nf_status: "enviado", envio_status: "shipped" }), "enviado");
  assert.equal(fase({ ...base, situacao: "bloqueado" }), "atencao");
  assert.equal(fase({ ...base, situacao: "no_erp", gravacao: "gravado", nunota_nf: 2, nf_status: "divergente" }), "atencao");
  assert.equal(fase({ ...base, situacao: "cancelado", nunota: 1 }), "cancelado");
});

test("réguas: valida limites e simula impacto", async () => {
  const { validarReguas, simularReguas } = await import("../src/sync.ts");
  assert.equal(validarReguas({ gold_special: { fator: 1.1236, soma: 70 }, gold_pro: { fator: 1.2, soma: 70 } }).ok, true);
  assert.equal(validarReguas({ gold_special: { fator: 3, soma: 70 }, gold_pro: { fator: 1.2, soma: 70 } }).ok, false);
  assert.equal(validarReguas({ gold_special: { fator: 1.1, soma: -1 }, gold_pro: { fator: 1.2, soma: 70 } }).ok, false);
  const an = [{ item_id: "M1", sku: "A", status: "active", sub_status: "", qtd_ml: 1, preco_ml: 1193.6, listing_type: "gold_special" }];
  const erp = new Map([["A", { disp: 1, ativo: true, preco_loja: 1000 }]]);
  const s = simularReguas(an, erp, { gold_special: { fator: 1.1236, soma: 30 }, gold_pro: { fator: 1.2, soma: 30 } });
  assert.equal(s.avaliados, 1); assert.equal(s.mudam, 1); assert.equal(s.descem, 1);
  assert.equal(s.exemplos[0].para, 1153.6);
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

// XML ILUSTRATIVO — estrutura de nfeProc, dados inventados.
const nfe = (cStat = "100", mod = "55") =>
  `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
  `<NFe><infNFe Id="NFe35260900000000000100550010000008901000000001"><ide><mod>${mod}</mod><serie>1</serie><nNF>890</nNF></ide>` +
  `<emit><CNPJ>00000000000100</CNPJ></emit></infNFe></NFe><protNFe versao="4.00"><infProt><chNFe>35260900000000000100550010000008901000000001</chNFe>` +
  `<cStat>${cStat}</cStat></infProt></protNFe></nfeProc>`;

test("valida nfeProc autorizada modelo 55", async () => {
  const { validarNfeProc } = await import("../src/xml.ts");
  const i = validarNfeProc(nfe());
  assert.equal(i.chave, "35260900000000000100550010000008901000000001");
  assert.equal(i.numero, "890");
  assert.equal(i.serie, "1");
  assert.equal(i.cnpjEmitente, "00000000000100");
  assert.throws(() => validarNfeProc(nfe("110")), /cStat 110/);
  assert.throws(() => validarNfeProc(nfe("100", "65")), /modelo 65/);
  assert.throws(() => validarNfeProc(nfe().slice(0, -20)), /cortado/);
  assert.throws(() => validarNfeProc("<NFe></NFe>"), /nfeProc/);
});

test("sync: quantidade, preço, pausado pelo vendedor e SKU duplicado", async () => {
  const { planejar, precoAlvo } = await import("../src/sync.ts");
  assert.equal(precoAlvo(1000, "gold_special"), 1193.6);
  assert.equal(precoAlvo(null, "gold_special"), null);
  const an = (id: string, sku: string, qtd: number, preco: number | null, extra = {}) =>
    ({ item_id: id, sku, status: "active", sub_status: "", qtd_ml: qtd, preco_ml: preco, listing_type: "gold_special", ...extra });
  const erp = new Map([
    ["CEL1", { disp: 3, ativo: true, preco_loja: 1000 }],
    ["CEL2", { disp: -2, ativo: true, preco_loja: 500 }],
    ["CEL3", { disp: 5, ativo: false, preco_loja: 500 }],
    ["CEL4", { disp: 2, ativo: true, preco_loja: 1000 }],
    ["CEL5", { disp: 1, ativo: true, preco_loja: 2000 }],
  ]);
  const { acoes, alertas, ignorados } = planejar([
    an("MLB1", "CEL1", 1, 1193.6),                                  // sobe 1→3, preço igual
    an("MLB2", "CEL2", 2, 631.8),                                   // negativo → zera
    an("MLB3", "CEL3", 1, 631.8),                                   // inativo → zera
    an("MLB4", "CEL4", 0, 1100, { status: "paused", sub_status: "out_of_stock" }), // repõe + preço
    an("MLB5", "CEL4", 2, 1193.6),                                  // duplicado → 0
    an("MLB6", "CEL1", 0, null, { status: "paused", sub_status: "paused_by_seller" }), // nunca mexe
    an("MLB7", "CEL5", 1, 1000),                                    // preço +140% → alerta
    an("MLB8", "CEL9", 1, 10),                                      // SKU inexistente → não mexe
  ], erp);
  const por = Object.fromEntries(acoes.map((a) => [a.item_id, a]));
  assert.equal(por.MLB1.qtd_para, 3); assert.equal(por.MLB1.preco_para, null);
  assert.equal(por.MLB2.qtd_para, 0);
  assert.equal(por.MLB3.qtd_para, 0); assert.match(por.MLB3.motivo, /inativo/);
  assert.equal(por.MLB4.qtd_para, 2); assert.equal(por.MLB4.preco_para, 1193.6); assert.match(por.MLB4.motivo, /repor/);
  assert.equal(por.MLB5.qtd_para, 0); assert.match(por.MLB5.motivo, /duplicado/);
  assert.equal(por.MLB6, undefined);
  assert.equal(por.MLB7, undefined);
  assert.equal(por.MLB8, undefined);
  assert.ok(alertas.some((x) => /140%|25%/.test(x)));
  assert.ok(alertas.some((x) => /CEL9/.test(x)));
  assert.ok(alertas.some((x) => /CEL4 em 2/.test(x)));
  assert.equal(ignorados, 2);
});

test("sync: aborta leitura suspeita e zeragem em massa", async () => {
  const { motivoParaAbortar } = await import("../src/sync.ts");
  const z = (n: number) => Array.from({ length: n }, (_, i) => ({ item_id: "M" + i, sku: "S", qtd_de: 1, qtd_para: 0, preco_de: null, preco_para: null, motivo: "zerar" }));
  assert.equal(motivoParaAbortar(z(2), { skusPedidos: 400, skusLidos: 400, comSaldo: 200, comSaldoAnterior: 210, maxZerar: 30 }), null);
  assert.match(motivoParaAbortar(z(2), { skusPedidos: 400, skusLidos: 100, comSaldo: 200, comSaldoAnterior: 210, maxZerar: 30 })!, /suspeita/);
  assert.match(motivoParaAbortar(z(31), { skusPedidos: 400, skusLidos: 400, comSaldo: 200, comSaldoAnterior: 210, maxZerar: 30 })!, /zerados/);
  assert.match(motivoParaAbortar(z(0), { skusPedidos: 400, skusLidos: 400, comSaldo: 50, comSaldoAnterior: 210, maxZerar: 30 })!, /caíram/);
});
