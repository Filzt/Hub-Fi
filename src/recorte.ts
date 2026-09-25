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
//
// Faixa da NF: a etiqueta da Base trazia em cima número, série, emissão e o código de
// barras da chave de acesso (foto da etiqueta real, 24/09/2026). Isso NÃO vem do ML —
// nem no PDF nem no ZPL (conferido em 25/09/2026) —, então desenhamos aqui. Para caber
// em 10x15, a etiqueta do ML é comprimida só na altura: a largura fica 1:1, então as
// barras do código de envio mantêm a espessura; o QR fica levemente achatado.

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { code128C } from "./code128.ts";

/** Dados da NF-e para a faixa de cima (tirados do Sankhya na hora de imprimir). */
export interface FaixaNf {
  chave: string; // 44 dígitos
  numero: number;
  serie: string;
  emissao: string; // já formatada, ex.: "24/09/2026 19:32:54"
}

const FAIXA_H = 54; // pt

/** "2026-09-24T19:32:54-03:00" → "24/09/2026 19:32:54" (horário do próprio XML). */
export function formatarEmissao(dhEmi: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/.exec(dhEmi.trim());
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : dhEmi.trim();
}


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
export async function recortarEtiqueta(pdf: Uint8Array, nf?: FaixaNf | null): Promise<Uint8Array | null> {
  const origem = await PDFDocument.load(pdf);
  const saida = await PDFDocument.create();
  if (!(await anexarEtiqueta(saida, origem, nf))) return null;
  return saida.save();
}

/** Anexa a etiqueta recortada de `origem` em `saida`. Falso se o layout não bater. */
export async function anexarEtiqueta(saida: PDFDocument, origem: PDFDocument, nf?: FaixaNf | null): Promise<boolean> {
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
  const W = PAGINA_10X15.w;
  const H = PAGINA_10X15.h;
  const nova = saida.addPage([W, H]);
  if (!nf) {
    const escala = Math.min(W / w, H / h);
    nova.drawPage(embutida, { x: (W - w * escala) / 2, y: (H - h * escala) / 2, width: w * escala, height: h * escala });
    return true;
  }
  const alturaUtil = H - FAIXA_H - 4;
  const sx = Math.min(1, W / w);
  const sy = Math.min(1, alturaUtil / h);
  nova.drawPage(embutida, { x: (W - w * sx) / 2, y: (alturaUtil - h * sy) / 2, width: w * sx, height: h * sy });
  await desenharFaixa(saida, nova, nf);
  return true;
}

async function desenharFaixa(saida: PDFDocument, pagina: ReturnType<PDFDocument["addPage"]>, nf: FaixaNf): Promise<void> {
  const W = PAGINA_10X15.w;
  const H = PAGINA_10X15.h;
  const fonte = await saida.embedFont(StandardFonts.Helvetica);
  const negrito = await saida.embedFont(StandardFonts.HelveticaBold);
  const preto = rgb(0, 0, 0);
  const margem = 8;

  const texto = `NF-e Nº ${String(nf.numero).padStart(9, "0")}    Série ${nf.serie.padStart(3, "0")}    Emissão ${nf.emissao}`;
  pagina.drawText(texto, { x: margem, y: H - margem - 7, size: 7.5, font: negrito, color: preto });

  // Código de barras da chave (Code 128 C), largura total menos as margens.
  const larguras = code128C(nf.chave);
  const modulos = larguras.reduce((s, x) => s + x, 0);
  const modulo = (W - 2 * margem) / modulos;
  const topo = H - margem - 11;
  const altura = 24;
  let x = margem;
  larguras.forEach((l, i) => {
    if (i % 2 === 0) pagina.drawRectangle({ x, y: topo - altura, width: l * modulo, height: altura, color: preto });
    x += l * modulo;
  });

  const digitos = nf.chave.replace(/(\d{4})(?=\d)/g, "$1 ");
  const tam = 6.5;
  pagina.drawText(digitos, { x: (W - fonte.widthOfTextAtSize(digitos, tam)) / 2, y: topo - altura - 8, size: tam, font: fonte, color: preto });
  pagina.drawLine({ start: { x: 0, y: H - FAIXA_H }, end: { x: W, y: H - FAIXA_H }, thickness: 0.6, color: preto });
}

/** Junta vários PDFs de envio em um só, cada etiqueta numa página 10x15. */
export async function juntarEtiquetas(
  itens: Array<{ pdf: Uint8Array; nf?: FaixaNf | null }>,
): Promise<{ pdf: Uint8Array; foraDoPadrao: number }> {
  const saida = await PDFDocument.create();
  let foraDoPadrao = 0;
  for (const { pdf: bytes, nf } of itens) {
    const origem = await PDFDocument.load(bytes);
    if (!(await anexarEtiqueta(saida, origem, nf))) {
      // Layout inesperado: copia as páginas originais para não perder a etiqueta.
      foraDoPadrao++;
      const copiadas = await saida.copyPages(origem, origem.getPageIndices());
      copiadas.forEach((p) => saida.addPage(p));
    }
  }
  return { pdf: await saida.save(), foraDoPadrao };
}
