// Code 128, conjunto C (só dígitos, 2 por símbolo) — usado no código de barras da
// chave de acesso da NF-e (44 dígitos) na faixa da etiqueta, como a Base imprimia.
// Tabela padrão ISO/IEC 15417: larguras barra/espaço alternadas, começando por barra.

const PADROES = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232",
];
const START_C = 105;
const STOP = "2331112";
export const _PADROES = PADROES; // exposto para o teste de integridade da tabela

/**
 * Larguras (em módulos) de barras e espaços alternados, começando por barra,
 * para uma sequência de dígitos de tamanho par. Inclui start C, checksum e stop.
 */
export function code128C(digitos: string): number[] {
  if (!/^(\d\d)+$/.test(digitos)) throw new Error("code128C: exige quantidade par de dígitos");
  const valores = [START_C];
  for (let i = 0; i < digitos.length; i += 2) valores.push(Number(digitos.slice(i, i + 2)));
  const soma = valores.reduce((s, v, i) => s + v * (i === 0 ? 1 : i), 0);
  valores.push(soma % 103);
  const larguras = valores.flatMap((v) => [...PADROES[v]].map(Number));
  return [...larguras, ...[...STOP].map(Number)];
}
