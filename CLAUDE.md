# SkyHub: regras para quem mexe no código

## Textos do painel: sempre com inicial maiúscula

Regra do Filipe, de 25/09/2026. Vale para **todo texto visível**:

- títulos, rótulos, botões e opções de select;
- placeholders;
- tags e status;
- mensagens de erro e avisos;
- descrições.

Certo: `Operando`, `Para imprimir`, `Última leitura há 2 min`, `Com Flex`, `Ex.: campanha`.
Errado: `operando`, `para imprimir`, `última leitura há 2 min`.

- **Cada trecho separado por ` · ` começa com maiúscula:** `Token válido até 18:38 · Último aviso há 3 min`.
- **Valor que vem da API ou do banco e aparece sozinho na tela** (status, modo, mensagem de log, motivo): passe por `cap()` (`public/app.js`) ou por um mapa de rótulos.
  - Exemplos de mapa: `NOME_MODO`, `NOME_NF`, `TXT_SIT`, `TXT_SAUDE`.
  - `erro()` e `avisar()` já aplicam `cap()`.
- **No meio da frase continua minúsculo:** `Sankhya lido há 3 min`, `Pedido 9073 é agendado`.
- **Identificador técnico fica como está:** `orders_v2`, `MLB123`, `xd_drop_off`, `/orders/…`.

Antes de publicar uma tela nova, confira na prévia se algum texto começa com minúscula.

## Tabelas: sempre com paginação, ordenação, filtro e Excel

Regra do Filipe, 25/09/2026. Toda tabela do painel tem:
- paginação de 10 em 10, com opção de 10, 20, 50 ou Todas;
- ordenação clicando no cabeçalho;
- filtro por coluna;
- botão "Exportar Excel".

Isso é automático (`public/tabela.js`): basta montar `<table>` com `<thead>` dentro de `#conteudo`.

- Coluna sem título ou de checkbox (`th.sel`) fica de fora da ordenação, do filtro e do Excel.
- O checkbox de "selecionar todos" no cabeçalho marca **só a página aberta** (Filipe, 25/09/2026).
  - A tabela deixa no `<tbody>` só as linhas da página: basta ler as caixas do `tbody`.
  - `skyTabela.filtradas(table)` devolve as linhas de todas as páginas, para quando precisar.
- Tabela dentro da gaveta, ou com a classe `sem-tabela-padrao`, não recebe os controles.
- O Excel é `.xlsx`, nunca CSV. No CSV o Excel estraga o nº do pedido do ML (16 dígitos) e a chave da NF.

## Publicação

- Deploy manual com `npx wrangler deploy`, usando `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` do cofre (keyring `fi-ecommerce`).
- Rode `npm test` e `npx tsc -p .` antes.
- O Worker tem teto de 50 chamadas externas por requisição.
  - Lote que chama o ML: no máximo 20 itens com 1 chamada cada.
