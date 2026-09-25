# Plano — Nuvemshop da Skyline no SkyHub

Rascunho de 25/09/2026. Segundo canal depois do Mercado Livre. Nada disto está implementado.

**Objetivo:** a loja Skyline (store `7853674`, skylinemobile.com.br) entra no SkyHub igual ao ML:
pedido pago → pedido no Sankhya; saldo e preço do Sankhya → loja; NF e rastreio → loja; tudo
aparecendo nas mesmas telas de Pedidos, Expedição e Produtos, com o selo do canal.

## 1. Bloqueios — decisões do Filipe antes de escrever código

| # | Decisão | Por que trava |
|---|---|---|
| 1 | **TOP, vendedor, centro de custo, natureza e transportadora** do pedido do site | Hoje, pelo Sankhya, a venda do site parece entrar à mão (TOP 1191 ou 1009, usuário 12). *Hipótese:* não confirmei cruzando com a loja. |
| 2 | **Criar o app na Nuvemshop (Partners) e instalar na loja Skyline** | No cofre só existe a chave da Skytech (store 6752291). É preciso `NUVEMSHOP_SKYLINE_STORE`, `_TOKEN` e `_CLIENT_SECRET`, que serve para validar o webhook. Nunca reaproveitar a chave da Skytech: quebra 4 rotinas dela. |
| 3 | **A loja importa pedidos do ML?** (`storefront = "meli"`) | Se importa, o SkyHub ignora esses pedidos, senão o mesmo pedido entra duas vezes no Sankhya. |
| 4 | **Régua de preço da loja** | Preço de loja da tabela 0 direto, ou uma régua própria como a do ML. |
| 5 | **NF do site** | Continua a 1130 manual? A Nuvemshop não recebe o XML (ver §2) e só guarda um link público para ele. |
| 6 | **Dia do corte** | A equipe para de digitar o pedido do site no mesmo dia em que o SkyHub começa a gravar. |

## 1.1 O que o Sankhya já tem para venda online

Levantado em 25/09/2026, só leitura. Proposta para a decisão 1:

| Campo | Proposta | Por quê |
|---|---|---|
| TOP do pedido | **1001** "PEDIDO DE VENDA ONLINE" | Já existe e é usada à mão para venda online: 17 notas em 180 dias. |
| TOP do faturamento | **1128** "VENDA - NF-E VENDAS ONLINE" | É o par da 1001, como a 1130 é da 1090 no ML. |
| Centro de custo | **130800** "VENDAS ONLINE" | O ML usa 130300 "VENDAS MERCADO LIVRE". |
| Natureza | **1090000** "RECEITA DE VENDAS ONLINE" | O ML usa 1040000. |
| Vendedor | **A definir** | O ML tem o vendedor 9 "MERCADO LIVRE"; não há um "NUVEMSHOP"/"SITE". Criar um, ou usar 0. |
| Transportadora | **A definir** pelo frete da loja | A 1128 já saiu com 252 CORREIOS e 144 TECH ENVIOS. |

A venda de balcão da loja física usa a 1191/1009, com o vendedor 3 e o CC 130200. **Não é** o site.

## 2. Fatos da documentação oficial

Fonte: API 2025-03, tiendanube.github.io/api-documentation, lida direto em 25/09/2026.

- **Autenticação**
  - URL `https://api.nuvemshop.com.br/2025-03/{store_id}`, header `Authorization: Bearer`.
  - `User-Agent` é obrigatório (sem ele, 400).
  - O token não expira; só cai se o app for desinstalado ou se um token novo for gerado.
- **Limite de chamadas**
  - Balde de 40 chamadas, esvaziando a 2 por segundo, por loja × app.
  - Headers `x-rate-limit-*`.
  - A atualização de variante tem custo por peso, e os números não são publicados.
  - Medimos 40 / 2 por segundo na loja Skytech em 05/08; refazer a medição na loja Skyline.
- **Paginação**
  - Até 200 por página. Parar pelo header `Link rel="next"`: a página seguinte à última responde 404.
- **Webhook**
  - Eventos de pedido `order/paid`, `order/cancelled`, `order/updated` etc.
  - O corpo traz só `store_id`, `event` e `id`; é preciso reler o pedido com GET.
  - Assinatura `x-linkedstore-hmac-sha256` = HMAC-SHA256 do corpo cru com o client_secret.
  - Exige resposta 2xx em 3 s e tenta de novo por 48 h. Pode chegar duplicado e fora de ordem.
  - Webhooks de LGPD (store/redact, customers/redact, customers/data_request) são obrigatórios no app.
- **Pedido**
  - Campos de situação: `status`, `payment_status` (`paid` …) e `shipping_status`.
  - Comprador: `contact_identification` (CPF/CNPJ) e `billing_*`, incluindo `billing_state_registration`; `shipping_address`.
  - Itens: `products[]` com `variant_id`, `sku`, `price` e `quantity`. O id do item passa de int32: tratar sempre como texto.
  - `paid_at` vem preenchido em só 8% dos pedidos: usar `payment_status` e `created_at`.
- **Estoque e preço em lote**
  - `PATCH /products/stock-price`, até 50 variantes por chamada.
  - `location_id` é obrigatório se a loja tiver mais de um centro de distribuição.
  - Nunca usar `PUT` na coleção de variantes: ele apaga as variantes que ficarem de fora.
- **Envio**
  - `PATCH /orders/{id}/fulfillment-orders/{fo_id}` com o status e o código de rastreio.
  - Depois de `DISPATCHED`, o status não volta.
- **Nota fiscal**
  - Texto da doc: "We currently do not offer an Invoice API".
  - O padrão é um metafield do pedido, `nfe/list`, com a chave e o **link público** do XML.
- **Não encontrado na doc**
  - Os números do custo por peso.
  - O escopo que o metafield exige.
  - Se a assinatura vem em hex ou em base64: medir no primeiro webhook.

## 3. Como entra no SkyHub

**Canal vira conceito.** Hoje o código assume o ML em vários pontos: chave do pedido, `OBSERVACAO` de 16 dígitos, `shipment_id`, `item_id` MLB e cabeçalho fixo com a transportadora 261.

- Coluna `canal` em pedidos, eventos, envios e NF. A chave passa a ser `ns:<order_id>`.
- `OBSERVACAO` com prefixo, proposta `NS-<número>`, para não colidir com o ML no casamento. Confirmar com o Filipe.
- O cabeçalho do `incluirNota` sai de uma configuração por canal (decisão 1).

**Pedidos**
- Rota `/ns/webhook/<segredo>` que valida o HMAC antes de tudo.
- Registra o evento e responde na hora; a fila de eventos atual processa depois.
- Só processa pedido `payment_status = paid`, e ignora `storefront = "meli"` (decisão 3).
- Parceiro: vem de `contact_identification` e `billing_*`. A inscrição estadual tem no máximo 16 caracteres: nunca truncar.
- Item: SKU da variante → CODPROD, pela mesma regra do ML.
- Comissão: não existe comissão de marketplace. A taxa do meio de pagamento é outro dado, a decidir se entra.
- Cancelamento: igual ao ML. Vira alerta no painel; o SkyHub não cancela nota sozinho.

**Estoque e preço**
- Vínculo SKU ↔ variante lido do catálogo da loja, relido de hora em hora.
- Envio em lotes de 50, respeitando os headers de limite.
- **Risco principal:** o recondicionado costuma ter **1 unidade**, e agora ele está em dois canais ao mesmo tempo.
  - O saldo só reserva quando o pedido 1090 é gravado.
  - Na janela até lá, a mesma unidade pode vender no ML e no site.
  - Mitigação: venda em um canal zera na hora o SKU no outro canal (sob evento, sem esperar os 2 min).

**NF e envio**
- O XML fica num link do SkyHub com token longo e validade, porque ele tem dados do comprador (LGPD).
- O SkyHub grava o metafield `nfe/list` e depois atualiza o fulfillment com o rastreio.

**Painel** (as telas já estão preparadas)
- Pedidos e Expedição mostram o selo `NS`.
- Produtos ganha a coluna Nuvemshop (hoje "em breve").
- Canais de venda → Nuvemshop: vínculo SKU ↔ variante, precificação e saúde da integração.
- Integrações → Visão geral ganha o segundo canal.

## 4. Fases

| Fase | Entrega | Critério para seguir | Volta atrás |
|---|---|---|---|
| 0 | Decisões do §1, app instalado, chaves no cofre, limite medido, `GET /locations` | Tudo respondido | — |
| 1 | Só leitura: vínculo SKU ↔ variante e divergência de estoque e preço na tela Produtos | Vínculo sem SKU duplicado ou órfão sem explicação | Desligar a rotina |
| 2 | Pedidos em sombra: monta o `incluirNota` sem gravar e compara com o que a equipe digitou (1 semana) | 100% dos pedidos montados, zero divergência de produto e valor | Desligar a rotina |
| 3 | Corte: grava o pedido e trata o cancelamento | Conciliação diária pedido × Sankhya sem duplicata | Voltar à digitação manual; o dedupe por `OBSERVACAO` protege |
| 4 | Estoque automático e zeragem cruzada entre canais; depois o preço | Zero venda de unidade já vendida no outro canal | Modo sombra |
| 5 | NF (metafield) e rastreio | Pedido com NF e rastreio visíveis ao comprador | Parar o envio do metafield |

Cada fase que grava em produção passa pela aprovação do Filipe antes de ligar.
