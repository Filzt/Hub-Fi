# skyhub — Mercado Livre ↔ Sankhya (Skyline)

Worker da Cloudflare que vai substituir a Base no canal Mercado Livre da Skyline:
anúncio a partir do SKU, pedido no Sankhya com comissão e frete, XML da NF-e de
volta ao ML, etiqueta e painel de operação.

## Estado em 24/09/2026

Tudo no automático, a cada 2 min (cron) + webhook do ML em tempo real:

| Fluxo | Variável | Modo |
|---|---|---|
| Venda ML → parceiro + pedido 1090 confirmado no Sankhya | `MODO` | automatico |
| NF 1130 autorizada → XML ao ML (libera etiqueta) | `XML_MODO` | automatico |
| Venda cancelada → cancela 1090 não faturado (`CACSP.cancelarNota`) | `CANCELAMENTO_MODO` | automatico |
| Estoque Sankhya → ML | `ESTOQUE_MODO` | automatico |
| Preço (tabela 0 × régua) → ML | `PRECO_MODO` | automatico |

Painel (`public/`, Workers Assets): **Pedidos** (esteira por fase), **Expedição**
(bipagem e impressão da etiqueta 10x15 do ML), **Produtos**, **Precificação** (réguas
por marketplace, com simulação e histórico) e **Integração** (diagrama ML ↔ SkyHub ↔
Sankhya, NF-e, logs e eventos).

Pendente: publicação de anúncio a partir do SKU; login individual (Cloudflare Access);
conta Cloudflare da empresa.

## Modo de operação (`MODO` no `wrangler.toml`)

A Base foi desligada em 24/09/2026. O Worker lê cada pedido do ML, monta o parceiro
(se o comprador for novo) e o `CACSP.incluirNota`, e grava conforme o modo:

| MODO | Escrita no Sankhya |
|---|---|
| `sombra` | nunca |
| `manual` | só pelo botão **gravar no Sankhya** do painel (ou `POST /api/pedidos/<order_id>/gravar`) |
| `automatico` | sozinho, ao receber a notificação do ML |

Trocar de modo = editar o `wrangler.toml` e dar push (vira deploy).

| Situação no painel | Significado |
|---|---|
| `pronto` | pago, com tudo resolvido; pode gravar (cria parceiro se for novo) |
| `no_erp` | já existe pedido 1090 com esse número do ML e bate |
| `divergente` | existe 1090, mas difere do ML — ver detalhe |
| `bloqueado` | falta dado: SKU sem cadastro/ambíguo, CPF/CNPJ, CEP fora da TSICEP, IE > 16 |
| `cancelado` | cancelado no ML; alerta se existe 1090 ou NF 1130 autorizada |
| `aguardando_pagamento` | order ainda não `paid` |
| `aguardando_comissao` | ML ainda não calculou o `sale_fee` (acontece no 1º aviso da venda); a próxima notificação reavalia |

Contra duplicata: trava por pedido e por CPF/CNPJ no Durable Object, releitura da
`TGFCAB` pela `OBSERVACAO` dentro da trava, e confirmação pela leitura quando a
resposta do Sankhya se perde.

## Contexto do Sankhya da Skyline (conferido em 24/09/2026)

- **Nota modelo da Base: NUNOTA 3560** (TOP 1090, `TIPMOV='Z'`, sem itens). Dela vêm
  `TIPFRETE='S'` e `CODPARCTRANSP=261` (MERCADO ENVIOS), presentes em 427 de 428
  pedidos ML reais; a 1130 herda e a transportadora sai no XML. Serviu de referência,
  não de regra: o que vale é o que os pedidos reais mostram.
- Cabeçalho dos 413 pedidos 1090 da Base: EMP 1, TIPVENDA 2, VEND 9, CENCUS 130300,
  NAT 1040000 — 100% iguais ao template.
- Cada pedido da Base tem **1 item**; parceiro é **1 por comprador** (CPF em `CGC_CPF`,
  único). `AD_VLRCOMISSAO` a Base preenche; `AD_FRETEMKTP` nunca.
- `OBSERVACAO` às vezes recebe texto do operador depois do número do ML
  (`2000014970833969 - IMEI ...`): a busca casa pelos 16 primeiros caracteres.
- XML autorizado: `TGFNFE.XMLENVCLI` (`<nfeProc>`, ≤ 8 KB).
- **Para o contador:** todas as NF-e de venda ML saem com `indPres=0` ("não se aplica").
  Venda pela internet costuma ser `indPres=2`, com dados do intermediador. Não mexemos —
  é decisão fiscal.

## Arquitetura

- `src/index.ts` — rotas: `POST /ml/webhook`, `/api/*`, `/painel`; cron a cada 10 min.
- `src/meli.ts` — cliente do ML e o Durable Object `MeliToken`, **dono único** do token
  (o refresh do ML é de uso único e rotaciona).
- `src/sankhya.ts` — gateway `api.sankhya.com.br`, só `DbExplorerSP.executeQuery`.
- `src/store.ts` — Durable Object `Store` (SQLite): eventos com retry/backoff, pedidos, log.
- `src/nota.ts` — funções puras: consolida o pack, calcula comissão/frete, monta o
  `incluirNota`, compara com a Base. Testado em `test/nota.test.ts`.
- `src/processamento.ts` — orquestra um pedido.
- `src/config.ts` — cabeçalho fixo (TOP 1090, TIPVENDA 2, VEND 9, EMP 1, CENCUS 130300,
  NAT 1040000), retry e timeouts.

Regras de dado:
- `OBSERVACAO` = nº do ML puro (pack_id quando existe; a sombra mostra qual a Base usou).
- `AD_VLRCOMISSAO` = Σ `order_items[].sale_fee × quantity` (sale_fee unitário: **não
  confirmado**; pedido com quantidade > 1 gera alerta).
- `AD_FRETEMKTP` = `senders[].cost` de `GET /shipments/{id}/costs` (0 = não cobrado).
- SKU do ML (`seller_sku`) → `TGFPRO.REFERENCIA` → `CODPROD`; parceiro por `TGFPAR.CGC_CPF`.

## Configuração (uma vez)

1. **Secrets do Worker** (painel da Cloudflare → Worker → Settings → Variables, tipo
   *Secret*): `MELI_CLIENT_ID`, `MELI_CLIENT_SECRET`, `SANKHYA_CLIENT_ID`,
   `SANKHYA_CLIENT_SECRET`, `SANKHYA_XTOKEN`, `ADMIN_TOKEN`.
   `python scripts\copiar_secrets.py` copia cada um do cofre `fi-ecommerce` para a área
   de transferência (sem mostrar na tela) e gera o `ADMIN_TOKEN` se ainda não existir.
2. **Cloudflare Access** na rota `/painel` e `/api/*` (recomendado além do ADMIN_TOKEN).
3. **DevCenter do ML** (app 903508635576879):
   - permissões funcionais de **Vendas/Pedidos**, **Envios** e **Faturamento** — hoje o
     app só tem publicação, e `/orders` devolve 403 `PA_UNAUTHORIZED`;
   - URL de notificações: `https://<worker>/ml/webhook`, tópicos `orders_v2`, `shipments`,
     `invoices`, `post_purchase`;
   - depois de mudar permissão, **reautorizar** o OAuth para o token ganhar os escopos.
4. **Semear o token** (corte do dono do token):
   `python scripts\semear_token.py https://<worker> --enviar` (sem `--enviar` só confere).
   Entrega o refresh local ao Worker, grava `SKYHUB_URL` no cofre e aposenta o arquivo
   de token local. Com `SKYHUB_URL` no cofre, o `ml_api.py` (e o vigia de estoque, que o
   usa) pede o token em `GET /api/meli/access-token` e **não renova mais localmente**.
   Rollback: apagar `SKYHUB_URL` do cofre e reautorizar o OAuth (`ml_api.py --trocar-code`).

## Desenvolvimento

```bash
npm install
npm test            # funções puras
npx tsc -p .        # tipos (rode `npx wrangler types` após mudar o wrangler.toml)
npm run check       # empacota sem publicar
```

`npm run dev` sobe local; copie `.dev.vars.example` para `.dev.vars` (ignorado pelo git).

## Operação

- Painel: `https://<worker>/painel` → informe o ADMIN_TOKEN.
- Reprocessar um pedido: botão no painel ou `POST /api/pedidos/<order_id>/processar`.
- Evento com erro: aba Eventos → reabrir. Erro temporário (5xx, 429, rede) tenta de novo
  sozinho com backoff até 8 vezes; erro definitivo espera ação.

## Rollback

Nesta fase não há o que desfazer no ERP/ML: basta desligar a URL de notificação no
DevCenter ou excluir o Worker. A Base segue operando normalmente.

## Próximas fases

1. Passar para `automatico` depois dos primeiros pedidos gravados à mão conferidos.
2. XML da 1130 (`TGFNFE.XMLENVCLI`) → `POST /shipments/{id}/invoice_data`.
3. Etiqueta (`/shipment_labels`, até 50 por chamada) e impressão em lote.
4. Estoque e preço; publicação a partir do SKU.
