// SkyHub — tabela padrão do painel: paginação (10/20/50/Todas), ordenar clicando no
// cabeçalho, filtro por coluna e exportar para Excel (.xlsx de verdade).
//
// Funciona sozinha: toda <table> com <thead> que aparecer em #conteudo ganha os controles.
// As telas continuam montando o HTML como sempre; quando uma tela redesenha o <tbody>,
// a tabela reaplica ordem, filtros e página. Estado lembrado por tela + cabeçalho.
// Coluna de checkbox ou sem título não ordena, não filtra e não vai para o Excel.
//
// Por que .xlsx e não CSV: no CSV o Excel transforma o nº do pedido do ML (16 dígitos) em
// 2,00002E+15 e corta a chave da NF (44). Aqui identificador vai como texto e valor como número.
"use strict";

window.skyTabela = (() => {
  const TAMANHOS = [10, 20, 50, 0]; // 0 = todas
  const estados = new Map(); // chave → { pagina, tamanho, ordem: {col, dir}, filtros: {col: texto}, filtrosAbertos }
  const DADOS = new WeakMap(); // table → { linhas: tr[], chave }

  const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const textoCelula = (td) => {
    if (!td) return "";
    const sel = td.querySelector("select");
    if (sel) return sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : "";
    return td.textContent.replace(/\s+/g, " ").trim();
  };

  /** Número em pt-BR ("R$ 1.193,60", "12", "-3,5") → number; identificador (muitos dígitos, zero à esquerda) → null. */
  function numero(t) {
    const s = String(t).replace(/^R\$\s*/, "").replace(/\s/g, "");
    if (!/^-?\d{1,3}(\.\d{3})*(,\d+)?$|^-?\d+(,\d+)?$/.test(s)) return null;
    const digitos = s.replace(/\D/g, "");
    // Identificador (nº de envio, pedido, chave): muitos dígitos sem separador, ou zero à esquerda.
    if (digitos.length > 12 || /^0\d/.test(s) || (/^\d+$/.test(s) && digitos.length >= 9)) return null;
    return Number(s.replace(/\./g, "").replace(",", "."));
  }
  /** "25/09/2026, 11:17:26" ou "25/09/2026" → chave ordenável. */
  function data(t) {
    const m = String(t).match(/^(\d{2})\/(\d{2})\/(\d{4})(?:,?\s*(\d{2}):(\d{2})(?::(\d{2}))?)?/);
    return m ? m[3] + m[2] + m[1] + (m[4] || "00") + (m[5] || "00") + (m[6] || "00") : null;
  }
  function comparar(a, b) {
    const na = numero(a), nb = numero(b);
    if (na !== null && nb !== null) return na - nb;
    const da = data(a), db = data(b);
    if (da && db) return da < db ? -1 : da > db ? 1 : 0;
    if (!a && b) return 1; // vazio sempre no fim
    if (a && !b) return -1;
    return String(a).localeCompare(String(b), "pt-BR", { numeric: true, sensitivity: "base" });
  }

  const colunasUteis = (tabela) => [...tabela.tHead.rows[0].cells].map((th, i) => ({
    i, th, titulo: th.textContent.trim(), util: !!th.textContent.trim() && !th.classList.contains("sel") && !th.querySelector("input"),
  }));

  function chaveDe(tabela) {
    const rota = (location.hash || "#").split("?")[0];
    return rota + "|" + (tabela.id || tabela.tBodies[0]?.id || "") + "|" + [...tabela.tHead.rows[0].cells].map((c) => c.textContent.trim()).join(",");
  }

  /** Linhas depois dos filtros e da ordem (todas as páginas). */
  function filtradas(tabela) {
    const d = DADOS.get(tabela);
    if (!d) return [];
    const e = estados.get(d.chave);
    const filtros = Object.entries(e.filtros).filter(([, v]) => v.trim()).map(([c, v]) => [Number(c), semAcento(v)]);
    let linhas = d.linhas.filter((tr) => filtros.every(([c, v]) => semAcento(textoCelula(tr.cells[c])).includes(v)));
    if (e.ordem) {
      const { col, dir } = e.ordem;
      linhas = linhas.map((tr, idx) => ({ tr, idx, t: textoCelula(tr.cells[col]) }))
        .sort((x, y) => comparar(x.t, y.t) * dir || x.idx - y.idx).map((x) => x.tr);
    }
    return linhas;
  }

  let observador = null;
  const semObservar = (fn) => {
    if (observador) observador.disconnect();
    try { fn(); } finally { if (observador) { observador.takeRecords(); ligarObservador(); } }
  };

  function desenhar(tabela) {
    const d = DADOS.get(tabela);
    const e = estados.get(d.chave);
    const lista = filtradas(tabela);
    const tam = e.tamanho || lista.length || 1;
    const paginas = Math.max(1, Math.ceil(lista.length / tam));
    e.pagina = Math.min(Math.max(1, e.pagina), paginas);
    const ini = (e.pagina - 1) * tam;
    const visiveis = e.tamanho ? lista.slice(ini, ini + tam) : lista;
    semObservar(() => {
      const tb = tabela.tBodies[0];
      tb.replaceChildren(...visiveis);
      // Sem dado nenhum: mantém a mensagem da própria tela ("Nenhum envio despachado hoje.").
      if (!visiveis.length && !d.linhas.length && d.vazias.length) tb.replaceChildren(...d.vazias);
      else if (!visiveis.length) {
        const tr = document.createElement("tr");
        tr.className = "tabela-vazia";
        tr.innerHTML = '<td colspan="' + tabela.tHead.rows[0].cells.length + '" class="vazio">' + (d.linhas.length ? "Nenhuma linha com esses filtros." : "Nada por aqui.") + "</td>";
        tb.appendChild(tr);
      }
      // cabeçalho: seta de ordem
      colunasUteis(tabela).forEach((c) => {
        c.th.classList.toggle("ordenado", !!e.ordem && e.ordem.col === c.i);
        c.th.dataset.dir = e.ordem && e.ordem.col === c.i ? (e.ordem.dir > 0 ? "asc" : "desc") : "";
      });
      const rod = tabela.parentElement.querySelector(":scope > .tabela-rodape");
      if (rod) {
        const fim = e.tamanho ? Math.min(ini + tam, lista.length) : lista.length;
        rod.querySelector(".tabela-info").textContent = lista.length
          ? "Mostrando " + (lista.length ? ini + 1 : 0).toLocaleString("pt-BR") + "–" + fim.toLocaleString("pt-BR") + " de " + lista.length.toLocaleString("pt-BR") +
            (lista.length !== d.linhas.length ? " (filtradas de " + d.linhas.length.toLocaleString("pt-BR") + ")" : "")
          : "0 linhas";
        rod.querySelector(".tabela-paginas").innerHTML = paginas > 1 ? botoesPagina(e.pagina, paginas) : "";
      }
      const barra = tabela.parentElement.querySelector(":scope > .tabela-barra");
      if (barra) {
        const n = Object.values(e.filtros).filter((v) => v.trim()).length;
        barra.querySelector("[data-tabela=filtros]").innerHTML = icone("i-filtro") + "Filtrar" + (n ? ' <span class="qtd-filtro">' + n + "</span>" : "");
      }
    });
  }

  const icone = (id) => '<svg class="ico" aria-hidden="true"><use href="#' + id + '"/></svg>';
  function botoesPagina(atual, total) {
    const nums = new Set([1, total, atual - 1, atual, atual + 1].filter((n) => n >= 1 && n <= total));
    const ordem = [...nums].sort((a, b) => a - b);
    let html = '<button type="button" data-pagina="' + (atual - 1) + '"' + (atual === 1 ? " disabled" : "") + ' aria-label="Página anterior">‹</button>';
    ordem.forEach((n, k) => {
      if (k && n - ordem[k - 1] > 1) html += '<span class="reticencias">…</span>';
      html += '<button type="button" data-pagina="' + n + '"' + (n === atual ? ' class="atual" aria-current="page"' : "") + ">" + n + "</button>";
    });
    return html + '<button type="button" data-pagina="' + (atual + 1) + '"' + (atual === total ? " disabled" : "") + ' aria-label="Próxima página">›</button>';
  }

  /** Liga a tabela (primeira vez) ou recolhe as linhas novas depois que a tela redesenhou o tbody. */
  function preparar(tabela) {
    if (!tabela.tHead || !tabela.tBodies[0] || tabela.closest(".gaveta, .sem-tabela-padrao")) return;
    const chave = chaveDe(tabela);
    if (!estados.has(chave)) estados.set(chave, { pagina: 1, tamanho: 10, ordem: null, filtros: {}, filtrosAbertos: false });
    const e = estados.get(chave);
    const linhas = [...tabela.tBodies[0].rows].filter((tr) => !tr.classList.contains("tabela-vazia"));
    // "Nenhum…" com colspan não é dado.
    const dados = linhas.filter((tr) => !(tr.cells.length === 1 && tr.cells[0].colSpan > 1));
    // Conjunto de linhas mudou de tamanho (outro filtro da tela): volta para a página 1.
    // Mesma quantidade (atualização automática a cada minuto): fica onde está.
    const antes = DADOS.get(tabela);
    if (antes && antes.linhas.length !== dados.length) e.pagina = 1;
    if (!antes && e.total !== undefined && e.total !== dados.length) e.pagina = 1;
    e.total = dados.length;
    DADOS.set(tabela, { linhas: dados, vazias: linhas.filter((tr) => !dados.includes(tr)), chave });
    if (!tabela.dataset.padrao) {
      tabela.dataset.padrao = "1";
      semObservar(() => montarControles(tabela, e));
    }
    desenhar(tabela);
  }

  function montarControles(tabela, e) {
    const pai = tabela.parentElement;
    const barra = document.createElement("div");
    barra.className = "tabela-barra";
    barra.innerHTML = '<button type="button" data-tabela="filtros" aria-expanded="' + e.filtrosAbertos + '"></button>' +
      '<button type="button" data-tabela="excel">' + icone("i-excel") + "Exportar Excel</button>";
    pai.insertBefore(barra, tabela);
    // linha de filtros por coluna
    const linhaFiltro = tabela.tHead.insertRow(-1);
    linhaFiltro.className = "tabela-filtros";
    linhaFiltro.hidden = !e.filtrosAbertos;
    colunasUteis(tabela).forEach((c) => {
      const th = document.createElement("th");
      if (c.util) th.innerHTML = '<input type="search" data-coluna="' + c.i + '" placeholder="Filtrar" aria-label="Filtrar ' + c.titulo.replace(/"/g, "") + '" value="' + (e.filtros[c.i] || "").replace(/"/g, "&quot;") + '">';
      linhaFiltro.appendChild(th);
      if (c.util) {
        c.th.classList.add("ordenavel");
        c.th.tabIndex = 0;
        c.th.setAttribute("role", "button");
        c.th.title = "Ordenar por " + c.titulo;
      }
    });
    const rod = document.createElement("div");
    rod.className = "tabela-rodape";
    rod.innerHTML = '<span class="tabela-info"></span><span class="espaco"></span>' +
      '<label class="tabela-tamanho">Linhas por página <select>' + TAMANHOS.map((t) => '<option value="' + t + '"' + (t === e.tamanho ? " selected" : "") + ">" + (t || "Todas") + "</option>").join("") + "</select></label>" +
      '<span class="tabela-paginas"></span>';
    pai.appendChild(rod);
  }

  function estadoDaTabela(tabela) { const d = DADOS.get(tabela); return d ? estados.get(d.chave) : null; }
  const tabelaDoEvento = (ev) => {
    const alvo = ev.target.closest(".tabela-barra, .tabela-rodape");
    return alvo ? alvo.parentElement.querySelector(":scope > table[data-padrao]") : ev.target.closest("table[data-padrao]");
  };

  function ordenar(tabela, col) {
    const e = estadoDaTabela(tabela);
    e.ordem = e.ordem && e.ordem.col === col ? (e.ordem.dir > 0 ? { col, dir: -1 } : null) : { col, dir: 1 };
    e.pagina = 1;
    desenhar(tabela);
  }

  document.addEventListener("click", (ev) => {
    const tabela = tabelaDoEvento(ev);
    if (!tabela) return;
    const e = estadoDaTabela(tabela);
    const th = ev.target.closest("th.ordenavel");
    if (th && !ev.target.closest("input, button, a")) return ordenar(tabela, th.cellIndex);
    const pag = ev.target.closest("[data-pagina]");
    if (pag && !pag.disabled) { e.pagina = Number(pag.dataset.pagina); desenhar(tabela); return; }
    const acao = ev.target.closest("[data-tabela]");
    if (!acao) return;
    if (acao.dataset.tabela === "filtros") {
      e.filtrosAbertos = !e.filtrosAbertos;
      const linha = tabela.tHead.querySelector(".tabela-filtros");
      linha.hidden = !e.filtrosAbertos;
      acao.setAttribute("aria-expanded", String(e.filtrosAbertos));
      if (e.filtrosAbertos) { const i = linha.querySelector("input"); if (i) i.focus(); }
    }
    if (acao.dataset.tabela === "excel") exportar(tabela);
  });
  document.addEventListener("keydown", (ev) => {
    const th = ev.target.closest && ev.target.closest("th.ordenavel");
    if (th && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); ordenar(th.closest("table"), th.cellIndex); }
  });
  document.addEventListener("input", (ev) => {
    const campo = ev.target.closest(".tabela-filtros input[data-coluna]");
    if (!campo) return;
    const tabela = campo.closest("table");
    const e = estadoDaTabela(tabela);
    e.filtros[campo.dataset.coluna] = campo.value;
    e.pagina = 1;
    clearTimeout(campo._t);
    campo._t = setTimeout(() => desenhar(tabela), 150);
  });
  document.addEventListener("change", (ev) => {
    const sel = ev.target.closest(".tabela-tamanho select");
    if (!sel) return;
    const tabela = tabelaDoEvento(ev);
    const e = estadoDaTabela(tabela);
    e.tamanho = Number(sel.value);
    e.pagina = 1;
    desenhar(tabela);
  });

  // ------------------------------------------------------------------ Excel
  function exportar(tabela) {
    const cols = colunasUteis(tabela).filter((c) => c.util);
    const linhas = filtradas(tabela).map((tr) => cols.map((c) => textoCelula(tr.cells[c.i])));
    const titulo = (document.getElementById("titulo")?.textContent || "SkyHub").trim();
    const blob = new Blob([gerarXlsx(cols.map((c) => c.titulo), linhas, titulo)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const nome = "skyhub-" + semAcento(titulo).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + new Date().toISOString().slice(0, 10) + ".xlsx";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  const xml = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const letra = (n) => { let s = ""; n++; while (n) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

  /** Planilha .xlsx mínima (1 aba, cabeçalho em negrito congelado, autofiltro). Pura: sem DOM. */
  function gerarXlsx(cabecalho, linhas, nomeAba) {
    const celula = (v, r, c, cab) => {
      const ref = letra(c) + r;
      if (cab) return '<c r="' + ref + '" t="inlineStr" s="1"><is><t xml:space="preserve">' + xml(v) + "</t></is></c>";
      const n = numero(v);
      if (n !== null) return '<c r="' + ref + '" s="' + (/,\d{2}$/.test(v) || /^R\$/.test(v) ? 2 : 0) + '"><v>' + n + "</v></c>";
      return v === "" || v === "—" ? "" : '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xml(v) + "</t></is></c>";
    };
    const larguras = cabecalho.map((h, c) => Math.min(60, Math.max(8, String(h).length + 2, ...linhas.slice(0, 500).map((l) => String(l[c] ?? "").length + 1))));
    const folha = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      "<cols>" + larguras.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join("") + "</cols><sheetData>" +
      '<row r="1">' + cabecalho.map((h, c) => celula(h, 1, c, true)).join("") + "</row>" +
      linhas.map((l, i) => '<row r="' + (i + 2) + '">' + l.map((v, c) => celula(v, i + 2, c, false)).join("") + "</row>").join("") +
      "</sheetData>" + (cabecalho.length ? '<autoFilter ref="A1:' + letra(cabecalho.length - 1) + (linhas.length + 1) + '"/>' : "") + "</worksheet>";
    const aba = xml(String(nomeAba || "SkyHub").replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
    const arquivos = {
      "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
      "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + (aba || "SkyHub") + '" sheetId="1" r:id="rId1"/></sheets>' +
        (cabecalho.length ? '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'' + (aba || "SkyHub").replace(/'/g, "''") + "'!$A$1:$" + letra(cabecalho.length - 1) + "$" + (linhas.length + 1) + "</definedName></definedNames>" : "") +
        "</workbook>",
      "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      "xl/styles.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
      "xl/worksheets/sheet1.xml": folha,
    };
    return zipSemCompressao(arquivos);
  }

  // ZIP "stored" (sem compressão): suficiente para o Excel e sem biblioteca externa.
  const TABELA_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = TABELA_CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zipSemCompressao(arquivos) {
    const enc = new TextEncoder();
    const partes = [], central = [];
    let desloc = 0;
    const agora = new Date();
    const hora = (agora.getHours() << 11) | (agora.getMinutes() << 5) | (agora.getSeconds() >> 1);
    const dia = ((agora.getFullYear() - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate();
    for (const [nome, conteudo] of Object.entries(arquivos)) {
      const n = enc.encode(nome), dados = enc.encode(conteudo), crc = crc32(dados);
      const loc = new DataView(new ArrayBuffer(30));
      loc.setUint32(0, 0x04034b50, true); loc.setUint16(4, 20, true); loc.setUint16(6, 0x0800, true); loc.setUint16(8, 0, true);
      loc.setUint16(10, hora, true); loc.setUint16(12, dia, true); loc.setUint32(14, crc, true);
      loc.setUint32(18, dados.length, true); loc.setUint32(22, dados.length, true); loc.setUint16(26, n.length, true); loc.setUint16(28, 0, true);
      partes.push(new Uint8Array(loc.buffer), n, dados);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true);
      cen.setUint16(12, hora, true); cen.setUint16(14, dia, true); cen.setUint32(16, crc, true); cen.setUint32(20, dados.length, true); cen.setUint32(24, dados.length, true);
      cen.setUint16(28, n.length, true); cen.setUint16(30, 0, true); cen.setUint16(32, 0, true); cen.setUint16(34, 0, true); cen.setUint16(36, 0, true);
      cen.setUint32(38, 0, true); cen.setUint32(42, desloc, true);
      central.push(new Uint8Array(cen.buffer), n);
      desloc += 30 + n.length + dados.length;
    }
    const tamCentral = central.reduce((s, p) => s + p.length, 0);
    const fim = new DataView(new ArrayBuffer(22));
    fim.setUint32(0, 0x06054b50, true); fim.setUint16(8, Object.keys(arquivos).length, true); fim.setUint16(10, Object.keys(arquivos).length, true);
    fim.setUint32(12, tamCentral, true); fim.setUint32(16, desloc, true);
    const todas = [...partes, ...central, new Uint8Array(fim.buffer)];
    const out = new Uint8Array(todas.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of todas) { out.set(p, o); o += p.length; }
    return out;
  }

  // ------------------------------------------------------------------ automático
  function ligarObservador() {
    const alvo = document.getElementById("conteudo");
    if (alvo && observador) observador.observe(alvo, { childList: true, subtree: true });
  }
  function varrer(registros) {
    const tabelas = new Set();
    for (const r of registros) {
      const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (!el) continue;
      const t = el.closest("table");
      if (t) tabelas.add(t);
      r.addedNodes.forEach((n) => { if (n.nodeType === 1) (n.matches("table") ? [n] : n.querySelectorAll("table")).forEach((x) => tabelas.add(x)); });
    }
    tabelas.forEach((t) => { if (t.isConnected) preparar(t); });
  }
  if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    observador = new MutationObserver(varrer);
    document.addEventListener("DOMContentLoaded", ligarObservador);
    if (document.readyState !== "loading") ligarObservador();
  }

  return { gerarXlsx, filtradas, comparar, numero };
})();
