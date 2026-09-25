// Casamento SKU do ERP → ficha de catálogo recondicionado do ML.
//
// Porte fiel de skyline/projetos/ml-catalogo/casar_fichas.py + fila_publicacao.py
// (titulo_modelo), que publicou 140 anúncios em set/2026. Mesmos dicionários e as
// mesmas barreiras, na mesma ordem — cada uma nasceu de um casamento errado real:
// A14 5G × 4G, S20 × S20+, J7 Prime × Prime 2 TV, iPhone X × iPad, titânio preto
// × titânio azul, e "PRETO" que não achava "Meia-noite" (R$ 535 mil sem ficha).

export const GRAU_ML: Record<string, string> = {
  EXCELENTE: "Excelente", "MUITO BOM": "Bom", PRO: "Excelente", BOM: "Bom", ACEITAVEL: "Aceitável",
};

// Sinônimos de cor do ERP → como o ML escreve (conferido contra o catálogo em 28/08 e 11/09/2026).
export const SIN_COR: Record<string, string[]> = {
  PRETO: ["preto", "black", "phantom black", "midnight", "preto brilhante", "meia noite", "preto espacial", "space black"],
  "PRETO BRILHANTE": ["preto brilhante", "jet black", "preto"],
  "PRETO FOSCO": ["preto fosco", "matte black", "preto"],
  BRANCO: ["branco", "white", "starlight", "estelar", "titanio branco"],
  AZUL: ["azul", "blue", "azul sierra", "azul pacifico"],
  "AZUL ESCURO": ["azul escuro", "dark blue", "navy", "azul-indigo"],
  CINZA: ["cinza", "gray", "grey", "space gray", "cinza espacial", "cinza-espacial"],
  "CINZA ESPACIAL": ["cinza espacial", "cinza-espacial", "space gray", "cinza"],
  "CINZA TITANIO": ["titanio cinza", "cinza titanio", "titanium gray"],
  PRATA: ["prata", "silver", "prateado"],
  DOURADO: ["dourado", "gold", "ouro", "ouro-fino"],
  "ROSE GOLD": ["rose gold", "rosa dourado", "ouro rosa"],
  ROSA: ["rosa", "pink"],
  ROXO: ["roxo", "purple", "deep purple", "violeta", "roxo profundo"],
  VIOLETA: ["violeta", "violet", "roxo", "purple", "bora purple"],
  LILAS: ["lilas", "lilás", "lavanda", "lavender", "lilac"],
  VERDE: ["verde", "green", "sage green", "verde alpino", "verde azulado"],
  VERMELHO: ["vermelho", "red", "product red"],
  VINHO: ["vinho", "burgundy", "bordo"],
  BRONZE: ["bronze", "mystic bronze"],
  COBRE: ["cobre", "copper"],
  GRAFITE: ["grafite", "graphite"],
  CREME: ["creme", "cream"],
  LARANJA: ["laranja", "orange"],
  TITANIO: ["titanio", "titânio", "titanium"],
  NATURAL: ["titanio natural", "natural titanium", "natural"],
  // 11/09/2026: a Apple e a Samsung batizam a cor; o ERP escreve o genérico.
  "PRETO ESPACIAL": ["preto espacial", "space black", "preto"],
  PRATEADO: ["prateado", "prata", "silver"],
  ESTELAR: ["estelar", "starlight"],
  "BRANCO ESTELAR": ["estelar", "starlight", "branco"],
  "BRANCO NUVEM": ["branco nuvem", "branco"],
  "DOURADO CLARO": ["dourado claro", "dourado", "gold"],
  ULTRAMARINO: ["ultramarino", "ultramarine"],
  "LARANJA COSMICO": ["laranja cosmico", "cosmic orange", "laranja"],
  "AZUL INTENSO": ["azul intenso", "azul"],
  "AZUL CEU": ["azul ceu", "sky blue", "azul"],
  "AZUL NEVOA": ["azul nevoa", "azul"],
  "AZUL SIERRA": ["azul sierra", "sierra blue", "azul"],
  "AZUL MARINHO": ["azul marinho", "navy", "azul escuro"],
  "AZUL NAVY": ["azul marinho", "navy", "azul escuro"],
  "AZUL COSMICO": ["azul cosmico", "azul"],
  "VERDE ACINZENTADO": ["verde acinzentado", "verde azulado", "verde"],
  SALVIA: ["salvia", "sage", "sage green", "verde"],
  "ROSA PALIDO": ["rosa palido", "rosa claro", "rosa"],
  LAVANDA: ["lavanda", "lavender", "lilas"],
  "OURO ROSA": ["ouro rosa", "rose gold", "rosa dourado"],
  SILVER: ["prata", "prateado", "silver"],
  // Titânio SEM o genérico "titanio": ele casava "titânio preto" com "titânio-azul".
  "TITANIO PRETO": ["titanio preto", "black titanium"],
  "TITANIO BRANCO": ["titanio branco", "white titanium"],
  "TITANIO NATURAL": ["titanio natural", "natural titanium"],
  "TITANIO DESERTO": ["titanio deserto", "desert titanium"],
  "TITANIO CREME": ["titanio creme"],
  "TITANIO AZUL": ["titanio azul", "blue titanium"],
};

// 5g e 4g NÃO são ruído: tratá-los assim casou o A14 5G com a ficha do A14 4G.
const RUIDO = new Set(["smartphone", "celular", "telefone", "dual", "sim", "gb", "tb", "ram", "tela", "de", "com",
  "cor", "e", "o", "a", "seminovo", "recondicionado", "libre", "polegadas"]);
// Se um lado tem e o outro não, não é o mesmo aparelho. "2" e "tv": J7 Prime × J7 Prime 2 TV.
const QUALIFICADORES = ["ultra", "plus", "pro", "max", "lite", "fe", "mini", "neo", "prime", "play", "power", "core",
  "hyper", "note", "2", "tv"];
const REDES = ["5g", "4g"];
const LINHAS = ["iphone", "ipad", "galaxy", "moto", "redmi", "poco", "xiaomi", "razr", "edge", "watch", "macbook"];

const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

// Memo: os nomes das ~11 mil fichas se repetem a cada SKU comparado; normalizar de novo
// era o grosso do custo. Limite para não crescer sem fim.
const memo = new Map<string, string>();
/** Minúsculas sem acento; "+" vira " plus " ANTES de limpar a pontuação (S20+ ≠ S20). */
export function n(s: unknown): string {
  const k = String(s ?? "");
  let v = memo.get(k);
  if (v === undefined) {
    v = semAcento(k).toLowerCase().replace(/\+/g, " plus ").replace(/[^a-z0-9 ]+/g, " ");
    if (memo.size > 60_000) memo.clear();
    memo.set(k, v);
  }
  return v;
}

/** '128GB' / '128 GB' / '1TB' → '128 GB' / '1 TB'. */
export function capNorm(s: unknown): string {
  const m = /(\d+)\s*(GB|TB)/i.exec(String(s ?? ""));
  return m ? `${m[1]} ${m[2].toUpperCase()}` : "";
}

/** Cor do ERP → chave do SIN_COR, com "¿" (acento perdido na exportação) como curinga de 1 letra. */
export function chaveDeCor(corErp: unknown): string {
  const chave = semAcento(String(corErp ?? "")).trim().toUpperCase();
  if (chave in SIN_COR || !chave.includes("¿")) return chave;
  const esc = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const padrao = new RegExp("^" + chave.split("¿").map(esc).join(".") + "$");
  const achados = Object.keys(SIN_COR).filter((k) => padrao.test(k));
  return achados.length === 1 ? achados[0] : chave.replace(/¿/g, "");
}

export function corBate(corErp: unknown, nomeFicha: unknown, corFicha: unknown): boolean {
  const alvo = n(corFicha) + " " + n(nomeFicha);
  const chave = chaveDeCor(corErp);
  for (const s of SIN_COR[chave] ?? [chave.toLowerCase()]) {
    const x = n(s).trim();
    if (x && alvo.includes(x)) return true;
  }
  return false;
}

const memoTok = new Map<string, Set<string>>();
function tokens(txt: unknown): Set<string> {
  const k = String(txt ?? "");
  let v = memoTok.get(k);
  if (!v) {
    v = new Set(n(k).split(" ").filter((p) => p && !RUIDO.has(p) && p.length > 1));
    if (memoTok.size > 30_000) memoTok.clear();
    memoTok.set(k, v);
  }
  return v;
}
const memoNum = new Map<string, Set<string>>();
function numerosDaFicha(b: string): Set<string> {
  let v = memoNum.get(b);
  if (!v) {
    v = new Set(b.match(/\b[a-z]?\d{1,4}\b/g) ?? []);
    if (memoNum.size > 30_000) memoNum.clear();
    memoNum.set(b, v);
  }
  return v;
}
const tem = (palavra: string, texto: string) => ` ${texto} `.includes(` ${palavra} `);

/** Linha, qualificadores e rede de um texto já normalizado (memo: a ficha se repete). */
const memoTraco = new Map<string, { linhas: string[]; quals: string; redes: string[] }>();
function tracos(t: string) {
  let v = memoTraco.get(t);
  if (!v) {
    v = {
      linhas: LINHAS.filter((x) => tem(x, t)),
      quals: QUALIFICADORES.map((q) => (tem(q, t) ? "1" : "0")).join(""),
      redes: REDES.filter((r) => tem(r, t)),
    };
    if (memoTraco.size > 30_000) memoTraco.clear();
    memoTraco.set(t, v);
  }
  return v;
}

/** True só quando TODAS as barreiras passam (da mais barata para a mais cara). */
export function modeloBate(produtoErp: string, nomeFicha: string, marcaErp = "", marcaFicha = ""): boolean {
  const a = n(produtoErp), b = n(nomeFicha);
  const ma = n(marcaErp).trim(), mb = n(marcaFicha).trim();
  if (ma && mb && ma !== mb) return false; // 1. marca
  const ta0 = tracos(a), tb0 = tracos(b);
  const la = ta0.linhas, lb = tb0.linhas;
  if (la.length && lb.length && !la.some((x) => lb.includes(x))) return false; // 2. linha (iPhone ≠ iPad)
  if (ta0.quals !== tb0.quals) return false; // 3. qualificador, nos dois sentidos
  const ra = ta0.redes, rb = tb0.redes;
  if (ra.length && rb.length && !ra.some((r) => rb.includes(r))) return false; // 4. rede, só se os dois declaram
  const numsA = new Set((a.match(/\b[a-z]?\d{1,4}\b/g) ?? []).filter((x) => !["5", "4", "5g", "4g"].includes(x)));
  const numsB = numerosDaFicha(b);
  if (numsA.size && ![...numsA].some((x) => numsB.has(x))) return false; // 5. designador (S23, A14, 13…)
  const soNumeros = new Set(a.match(/\d+/g) ?? []);
  const ta = [...tokens(produtoErp)].filter((t) => !soNumeros.has(t));
  const tb = tokens(nomeFicha);
  if (!ta.length) return false;
  return ta.filter((t) => tb.has(t)).length / ta.length >= 0.85; // 6. sobreposição
}

/** Só o modelo: tira grau (depois do " - "), capacidade e cor do título do ERP. */
export function tituloModelo(produto: unknown, cor: unknown): string {
  let t = String(produto ?? "").toUpperCase().split(" - ")[0];
  t = t.replace(/\d+\s*(GB|TB)/g, " ");
  for (const palavra of String(cor ?? "").toUpperCase().split(/\s+/).sort((x, y) => y.length - x.length)) {
    if (palavra.length > 2) t = t.split(palavra).join(" ");
  }
  return t.replace(/\s+/g, " ").trim();
}

export interface SkuErp { sku: string; produto: string; marca: string; cor: string; capacidade: string; qualidade: string }
export interface Ficha { pdp: string; nome: string; grau: string; cor: string; capacidade: string; marca: string; status: string }

/** Grau do ERP (AD_QUALIDADE) → grau do ML, com ou sem acento ("ACEITÁVEL"). */
export const grauMl = (qualidade: unknown): string | null => GRAU_ML[semAcento(String(qualidade ?? "")).trim().toUpperCase()] ?? null;

/** Chave de índice das fichas: só compara SKU com ficha de mesma capacidade e grau. */
export const chaveIndice = (capacidade: unknown, grau: unknown) => `${capNorm(capacidade)}|${String(grau ?? "")}`;

/** Motivo de o SKU não entrar no casamento, ou null se tem os atributos necessários. */
export function faltaAtributo(x: SkuErp): string | null {
  if (!capNorm(x.capacidade)) return "sem capacidade (AD_ARMAZENAMENTO)";
  if (!grauMl(x.qualidade)) return `grau "${x.qualidade || "vazio"}" sem equivalente no ML`;
  if (!String(x.cor ?? "").trim()) return "sem cor (AD_CORES)";
  return null;
}

/**
 * Fichas candidatas para o SKU, já ordenadas: cor escrita igual à do ERP primeiro,
 * depois ficha ativa, depois id menor (ficha antiga costuma ser a consolidada).
 */
export function candidatas(x: SkuErp, doIndice: Ficha[]): Ficha[] {
  const grau = grauMl(x.qualidade);
  const cap = capNorm(x.capacidade);
  const modelo = tituloModelo(x.produto, x.cor);
  const cands = doIndice.filter((f) =>
    f.status !== "closed" && capNorm(f.capacidade) === cap && f.grau === grau &&
    corBate(x.cor, f.nome, f.cor) && modeloBate(modelo, f.nome, x.marca, f.marca));
  const corErp = n(x.cor).trim();
  return cands.sort((f, g) => {
    const ex = (h: Ficha) => (n(h.cor).trim() === corErp ? 0 : 1);
    const at = (h: Ficha) => (h.status === "active" ? 0 : 1);
    return ex(f) - ex(g) || at(f) - at(g) || (f.pdp < g.pdp ? -1 : f.pdp > g.pdp ? 1 : 0);
  });
}
