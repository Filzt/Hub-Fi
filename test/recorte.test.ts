// Recorte da etiqueta 10x15 com um PDF sintético no layout do ML (sem dado de cliente).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { formatarEmissao, juntarEtiquetas, PAGINA_10X15, recortarEtiqueta } from "../src/recorte.ts";
import { _PADROES, code128C } from "../src/code128.ts";

async function pdfDoMl(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const etq = d.addPage([841.89, 595.28]); // A4 deitada com a etiqueta no canto
  etq.drawRectangle({ x: 31.18, y: 595.28 - 449.86, width: 255.69, height: 421.51, borderWidth: 1 });
  d.addPage([595.28, 841.89]); // lista de produto/SKU
  return d.save();
}

test("recorta a etiqueta do ML em uma página 10x15 e descarta a lista de produto", async () => {
  const saida = await recortarEtiqueta(await pdfDoMl());
  assert.ok(saida);
  const d = await PDFDocument.load(saida);
  assert.equal(d.getPageCount(), 1);
  const { width, height } = d.getPage(0).getSize();
  assert.ok(Math.abs(width - PAGINA_10X15.w) < 0.1 && Math.abs(height - PAGINA_10X15.h) < 0.1);
});

test("layout diferente do esperado não recorta (devolve null / copia o original)", async () => {
  const d = await PDFDocument.create();
  d.addPage([283.46, 425.2]);
  const bytes = await d.save();
  assert.equal(await recortarEtiqueta(bytes), null);
  const { pdf, foraDoPadrao } = await juntarEtiquetas([{ pdf: await pdfDoMl() }, { pdf: bytes }]);
  assert.equal(foraDoPadrao, 1);
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 2);
});

test("com NF, a etiqueta continua numa página só de 10x15", async () => {
  const nf = { chave: "35260965642378000134550010000008911951853563", numero: 891, serie: "1", emissao: "24/09/2026 19:32:54" };
  const saida = await recortarEtiqueta(await pdfDoMl(), nf);
  assert.ok(saida);
  const d = await PDFDocument.load(saida);
  assert.equal(d.getPageCount(), 1);
  assert.ok(Math.abs(d.getPage(0).getSize().height - PAGINA_10X15.h) < 0.1);
});

test("tabela do Code 128 íntegra: 106 padrões distintos de 11 módulos", () => {
  assert.equal(_PADROES.length, 106);
  assert.equal(new Set(_PADROES).size, 106);
  for (const p of _PADROES) assert.equal([...p].reduce((s, x) => s + Number(x), 0), 11, p);
  // 44 dígitos = start + 22 símbolos + checksum (6 larguras cada) + stop (7)
  assert.equal(code128C("3".repeat(44)).length, 24 * 6 + 7);
  assert.throws(() => code128C("123"));
});

test("emissão do XML formatada no padrão brasileiro", () => {
  assert.equal(formatarEmissao("2026-09-24T19:32:54-03:00"), "24/09/2026 19:32:54");
});
