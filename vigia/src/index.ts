// skyhub-vigia — Worker separado que avisa no celular (Telegram, e ntfy como 2ª tentativa) quando a rodada automática do
// SkyHub para. Separado de propósito: se o Cloudflare cortar a rodada do skyhub, este continua.
//
// A cada 5 min lê do Store do skyhub (binding de Durable Object de outro script, só leitura +
// o próprio estado do vigia) quando o Sankhya foi lido pela última vez na sincronização de
// estoque (meta "ultimo_erp_em", gravada a cada rodada que chega ao fim do estoque).
//   - parado há mais de LIMITE_MIN → aviso "parou", repetido no máximo a cada REPETIR_MIN;
//   - voltou depois de um aviso → aviso "voltou".
//
// Canais (docs lidas direto em 26/09/2026):
//   - Telegram (core.telegram.org/bots/api): POST JSON em /bot<token>/sendMessage {chat_id, text}.
//     Limite é por robô, não por IP: é o canal principal.
//   - ntfy (docs.ntfy.sh/publish): POST JSON na raiz https://ntfy.sh/ {topic, title, message...}.
//     O limite do ntfy.sh é por IP ("A visitor is identified by its IP address") e o IP de saída do
//     Cloudflare é compartilhado: em 26/09/2026 voltava 429 sempre. Fica só como 2ª tentativa.
// O aviso conta como entregue se QUALQUER canal aceitar.

interface StoreRpc {
  meta(chave: string): Promise<string | null>;
  setMeta(chave: string, valor: string): Promise<void>;
  log(nivel: string, ref: string | null, msg: string): Promise<void>;
}

interface Env {
  STORE: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN?: string; // secret: chave do robô (cofre: TELEGRAM_BOT_TOKEN)
  TELEGRAM_CHAT_ID?: string; // secret: conversa do Filipe com o robô
  NTFY_TOPIC?: string; // secret: nome do canal do ntfy (quem sabe o nome lê as mensagens)
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

async function enviar(url: string, corpo: unknown): Promise<string> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? "ok" : `HTTP ${r.status}`;
  } catch (e) {
    return `falha de rede (${(e as Error).message})`;
  }
}

/** Manda em todos os canais configurados; devolve "ok" se algum aceitou, senão o motivo de cada um. */
async function avisar(env: Env, titulo: string, texto: string, prioridade: number, tags: string[]): Promise<string> {
  const tentativas: Array<[string, Promise<string>]> = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    tentativas.push(["telegram", enviar(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: env.TELEGRAM_CHAT_ID, text: `${titulo}\n${texto}\n${env.PAINEL_URL}`, disable_web_page_preview: true })]);
  }
  if (env.NTFY_TOPIC) {
    tentativas.push(["ntfy", enviar("https://ntfy.sh/",
      { topic: env.NTFY_TOPIC, title: titulo, message: texto, priority: prioridade, tags, click: env.PAINEL_URL })]);
  }
  if (!tentativas.length) return "nenhum canal configurado";
  const res = await Promise.all(tentativas.map(async ([c, p]) => [c, await p] as const));
  return res.some(([, r]) => r === "ok") ? "ok" : res.map(([c, r]) => `${c} ${r}`).join("; ");
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
    if (req.method === "POST" && url.pathname === "/teste" && env.NTFY_TOPIC && req.headers.get("x-canal") === env.NTFY_TOPIC) {
      const r = await avisar(env, "SkyHub: teste", "Se você está lendo isto, o aviso do SkyHub chega no seu celular.", 3, ["bell"]);
      return new Response(r, { status: r === "ok" ? 200 : 502 });
    }
    return new Response("não encontrado", { status: 404 });
  },
};
