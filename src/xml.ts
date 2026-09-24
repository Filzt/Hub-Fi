// Validação do XML autorizado da NF-e antes de mandar ao ML. Função pura.

export interface NfeInfo {
  chave: string; // 44 dígitos
  numero: string;
  serie: string;
  modelo: string;
  cStat: string;
  cnpjEmitente: string;
}

/**
 * Aceita só <nfeProc> (NF-e + protocolo) modelo 55 autorizada (cStat 100) —
 * é o que o ML exige em POST /shipments/{id}/invoice_data.
 */
export function validarNfeProc(xml: string): NfeInfo {
  const t = String(xml ?? "").trim();
  if (!/^(<\?xml[^>]*\?>\s*)?<nfeProc[\s>]/.test(t)) throw new Error("XML não começa com <nfeProc>");
  if (!/<\/nfeProc>\s*$/.test(t)) throw new Error("XML sem </nfeProc> no fim (cortado?)");
  const tag = (nome: string, dentro = t) => dentro.match(new RegExp(`<${nome}>([^<]*)</${nome}>`))?.[1]?.trim() ?? "";
  const prot = t.match(/<protNFe[\s\S]*<\/protNFe>/)?.[0] ?? "";
  if (!prot) throw new Error("XML sem <protNFe> (NF não autorizada)");
  const cStat = tag("cStat", prot);
  if (cStat !== "100") throw new Error(`protocolo com cStat ${cStat || "vazio"} (esperado 100 = autorizada)`);
  const chave = tag("chNFe", prot) || (t.match(/Id="NFe(\d{44})"/)?.[1] ?? "");
  if (!/^\d{44}$/.test(chave)) throw new Error("chave de acesso ausente ou inválida");
  const modelo = tag("mod");
  if (modelo !== "55") throw new Error(`modelo ${modelo || "vazio"} (o ML só aceita 55)`);
  const emit = t.match(/<emit>[\s\S]*?<\/emit>/)?.[0] ?? "";
  return { chave, numero: tag("nNF"), serie: tag("serie"), modelo, cStat, cnpjEmitente: tag("CNPJ", emit) };
}
