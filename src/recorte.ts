// Recorte da etiqueta do ML para 10x15.
//
// O PDF de /shipment_labels (response_type=pdf) vem em A4: a página 1 é A4 deitada
// com a etiqueta no canto superior esquerdo e a página 2 é A4 em pé com a lista de
// produto/SKU (conferido no PDF real do envio 48094786737, 25/09/2026). O Filipe quer
// só a etiqueta, em 10x15, sem a lista. Não há parâmetro do ML confirmado para isso,
// então recortamos aqui.
//
// A moldura da etiqueta foi medida no PDF real (PyMuPDF, origem no topo):
// x 31,18 → 286,87 pt, y 28,35 → 449,86 pt, numa página de 841,89 x 595,28 pt.
// Se a página não tiver esse tamanho, o layout mudou: devolvemos null e quem chama
// usa o PDF original (imprime como antes, sem quebrar a expedição).

import { PDFDocument } from "pdf-lib";

const A4_DEITADA = { w: 841.89, h: 595.28 };
const MOLDURA = { x0: 31.18, x1: 286.87, yTopo0: 28.35, yTopo1: 449.86 };
const FOLGA = 2; // pt ao redor da moldura, para não cortar a borda
const CM = 72 / 2.54;
export const PAGINA_10X15 = { w: 10 * CM, h: 15 * CM };

const perto = (a: number, b: number) => Math.abs(a - b) < 2;

/**
 * Recebe o PDF do ML de UM envio e devolve um PDF 10x15 só com a etiqueta,
 * ou null se o layout não for o esperado.
 */
export async function recortarEtiqueta(pdf: Uint8Array): Promise<Uint8Array | null> {
  const origem = await PDFDocument.load(pdf);
  const saida = await PDFDocument.create();
  if (!(await anexarEtiqueta(saida, origem))) return null;
  return saida.save();
}

/** Anexa a etiqueta recortada de `origem` em `saida`. Falso se o layout não bater. */
export async function anexarEtiqueta(saida: PDFDocument, origem: PDFDocument): Promise<boolean> {
  const pagina = origem.getPages()[0];
  if (!pagina) return false;
  const { width, height } = pagina.getSize();
  if (!perto(width, A4_DEITADA.w) || !perto(height, A4_DEITADA.h) || pagina.getRotation().angle % 360 !== 0) return false;

  // pdf-lib usa origem embaixo: converte o y medido a partir do topo.
  const caixa = {
    left: MOLDURA.x0 - FOLGA,
    right: MOLDURA.x1 + FOLGA,
    bottom: height - MOLDURA.yTopo1 - FOLGA,
    top: height - MOLDURA.yTopo0 + FOLGA,
  };
  const embutida = await saida.embedPage(pagina, caixa);
  const w = caixa.right - caixa.left;
  const h = caixa.top - caixa.bottom;
  const escala = Math.min(PAGINA_10X15.w / w, PAGINA_10X15.h / h);
  const nova = saida.addPage([PAGINA_10X15.w, PAGINA_10X15.h]);
  nova.drawPage(embutida, {
    x: (PAGINA_10X15.w - w * escala) / 2,
    y: (PAGINA_10X15.h - h * escala) / 2,
    width: w * escala,
    height: h * escala,
  });
  return true;
}

/** Junta vários PDFs de envio em um só, cada etiqueta numa página 10x15. */
export async function juntarEtiquetas(pdfs: Uint8Array[]): Promise<{ pdf: Uint8Array; foraDoPadrao: number }> {
  const saida = await PDFDocument.create();
  let foraDoPadrao = 0;
  for (const bytes of pdfs) {
    const origem = await PDFDocument.load(bytes);
    if (!(await anexarEtiqueta(saida, origem))) {
      // Layout inesperado: copia as páginas originais para não perder a etiqueta.
      foraDoPadrao++;
      const copiadas = await saida.copyPages(origem, origem.getPageIndices());
      copiadas.forEach((p) => saida.addPage(p));
    }
  }
  return { pdf: await saida.save(), foraDoPadrao };
}
