// Recorte da etiqueta 10x15 com um PDF sintético no layout do ML (sem dado de cliente).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { juntarEtiquetas, PAGINA_10X15, recortarEtiqueta } from "../src/recorte.ts";

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
  const { pdf, foraDoPadrao } = await juntarEtiquetas([await pdfDoMl(), bytes]);
  assert.equal(foraDoPadrao, 1);
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 2);
});
