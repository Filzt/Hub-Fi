// skyhub-vigia — Worker separado que avisa no celular (ntfy) quando a rodada automática do
// SkyHub para. Separado de propósito: se o Cloudflare cortar a rodada do skyhub, este continua.
//
// A cada 5 min lê do Store do skyhub (binding de Durable Object de outro script, só leitura +
// o próprio estado do vigia) quando o Sankhya foi lido pela última vez na sincronização de
// estoque (meta "ultimo_erp_em", gravada a cada rodada que chega ao fim do estoque).
//   - parado há mais de LIMITE_MIN → aviso "parou", repetido no máximo a cada REPETIR_MIN;
//   - voltou depois de um aviso → aviso "voltou".
//
// ntfy (docs.ntfy.sh/publish, lida direto em 26/09/2026): POST JSON na raiz https://ntfy.sh/
// com {topic, title, message, tags, priority}. Limite do ntfy.sh é por IP (250 mensagens/dia) e o
// IP de saída do Cloudflare é compartilhado: se voltar 429, fica registrado no log do SkyHub.

interface StoreRpc {
  meta(chave: string): Promise<string | null>;
  setMeta(chave: string, valor: string): Promise<void>;
  log(nivel: string, ref: string | null, msg: string): Promise<void>;
}

interface Env {
  STORE: DurableObjectNamespace;
  NTFY_TOPIC: string; // secret: nome do canal do ntfy (quem sabe o nome lê as mensagens)
  PAINEL_URL: string;
}

const LIMITE_MIN = 10;
const REPETIR_MIN = 30;

type Estado = { parado: boolean; avisadoEm: number };

function store(env: Env): StoreRpc {
  return env.STORE.get(env.STORE.idFromName("principal")) as unknown as StoreRpc;
}

const hora = (ms: number) =>
  new Date(ms).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

async function avisar(env: Env, titulo: string, texto: string, prioridade: number, tags: string[]): Promise<string> {
  try {
    const r = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: env.NTFY_TOPIC, title: titulo, message: texto, priority: prioridade, tags, click: env.PAINEL_URL }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? "ok" : `HTTP ${r.status}`;
  } catch (e) {
    return `falha de rede (${(e as Error).message})`;
  }
}

export async function verificar(env: Env, agora = Date.now()): Promise<string> {
  const s = store(env);
  const [ultimaStr, etapa, estadoStr] = await Promise.all([s.meta("ultimo_erp_em"), s.meta("cron_etapa"), s.meta("vigia_estado")]);
  const ultima = Number(ultimaStr ?? 0);
  const estado: Estado = estadoStr ? JSON.parse(estadoStr) : { parado: false, avisadoEm: 0 };
  const minutos = Math.round((agora - ultima) / 60_000);
  const parado = !ultima || minutos > LIMITE_MIN;
  const ondeParou = etapa && !etapa.startsWith("fim:") ? ` Parou na etapa: ${etapa.split(":")[0]}.` : "";

  let resultado = parado ? `parado há ${minutos} min` : "ok";
  if (parado && (!estado.parado || agora - estado.avisadoEm >= REPETIR_MIN * 60_000)) {
    const r = await avisar(env, "SkyHub parado",
      `Estoque, preço e NF sem atualizar desde ${ultima ? hora(ultima) : "?"} (${minutos} min).${ondeParou} Pedidos do ML continuam entrando.`,
      5, ["rotating_light"]);
    resultado += `, aviso: ${r}`;
    await s.log(r === "ok" ? "aviso" : "erro", null, `vigia: SkyHub parado há ${minutos} min — aviso no celular: ${r}`);
    if (r === "ok") estado.avisadoEm = agora;
    estado.parado = true;
  } else if (!parado && estado.parado) {
    const r = await avisar(env, "SkyHub voltou", `Rodada automática andando de novo (última às ${hora(ultima)}).`, 3, ["white_check_mark"]);
    resultado += `, aviso de volta: ${r}`;
    await s.log("info", null, `vigia: SkyHub voltou — aviso no celular: ${r}`);
    estado.parado = false;
    estado.avisadoEm = 0;
  }
  await s.setMeta("vigia_estado", JSON.stringify(estado));
  await s.setMeta("vigia_em", String(agora));
  return resultado;
}

export default {
  async scheduled(_ev: ScheduledController, env: Env): Promise<void> {
    await verificar(env);
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    // Só um teste manual do canal, protegido pelo próprio nome do canal: POST /teste com o header x-canal.
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/teste" && req.headers.get("x-canal") === env.NTFY_TOPIC) {
      const r = await avisar(env, "SkyHub: teste", "Se você está lendo isto, o aviso do SkyHub chega no seu celular.", 3, ["bell"]);
      return new Response(r, { status: r === "ok" ? 200 : 502 });
    }
    return new Response("não encontrado", { status: 404 });
  },
};
