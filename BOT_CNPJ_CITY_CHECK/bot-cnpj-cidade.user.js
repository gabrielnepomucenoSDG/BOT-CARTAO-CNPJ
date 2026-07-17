// ==UserScript==
// @name         Bot CNPJ → Cartão completo (Receita)
// @namespace    https://local/bot-cnpj-cidade
// @version      2.0.0
// @description  Para cada CNPJ de uma lista, consulta o cartão CNPJ na Receita Federal e extrai TODOS os campos do comprovante (nome empresarial, fantasia, porte, atividades, natureza jurídica, endereço completo, situação cadastral etc.). O usuário marca o captcha; o script preenche, clica em Consultar, lê e avança. Exporta CSV ao fim.
// @author       -
// @match        https://solucoes.receita.fazenda.gov.br/Servicos/cnpjreva/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_download
// ==/UserScript==

/* eslint-disable no-var */
(function () {
  'use strict';

  // =========================================================================
  // 0) Constantes / chaves de estado persistido
  // =========================================================================
  var K = {
    fila: 'cnpjbot_fila',
    indice: 'cnpjbot_indice',
    resultados: 'cnpjbot_resultados',
    rodando: 'cnpjbot_rodando',
    ultimoStatus: 'cnpjbot_ultimo_status',
    aguardandoComprovante: 'cnpjbot_aguardando_comprovante',
    errosSeguidos: 'cnpjbot_erros_seguidos'
  };

  // Site atual é uma SPA em Angular (router-outlet, sem reload entre
  // "solicitação" e "comprovante") — a URL muda via client-side routing:
  //   .../Servicos/cnpjreva/            → formulário
  //   .../Servicos/cnpjreva/comprovante → resultado
  var URL_SOLICITACAO = 'https://solucoes.receita.fazenda.gov.br/Servicos/cnpjreva/';

  function estaNoComprovante() {
    return /\/comprovante(\/|$|\?)/i.test(location.pathname);
  }

  // Intervalos de polling do captcha
  var CAPTCHA_POLL_MS = 1200;
  var CAPTCHA_TIMEOUT_MS = 10 * 60 * 1000; // 10 min aguardando o usuário
  var RESULTADO_POLL_MS = 800;
  var RESULTADO_TIMEOUT_MS = 25 * 1000; // após clicar em Consultar

  // =========================================================================
  // Medidas de contenção de volume (não sobrecarregar o servidor da Receita)
  // =========================================================================
  // 1) Intervalo aleatório entre o fim de uma consulta e a próxima (evita
  //    padrão robótico de tempo fixo e dá um respiro ao servidor).
  var DELAY_MIN_MS = 500;
  var DELAY_MAX_MS = 1500;

  // 2) Pausa longa forçada a cada N consultas concluídas, mesmo que o
  //    usuário continue marcando captchas rapidamente.
  var PAUSA_A_CADA_N = 15;
  var PAUSA_LONGA_MS = 90 * 1000; // 90s

  // 3) Backoff: se vierem falhas seguidas (captcha recusado / erro / site
  //    fora do ar), o bot para sozinho em vez de insistir batendo no servidor.
  var MAX_ERROS_SEGUIDOS = 3;

  function delayAleatorio() {
    return DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
  }

  // =========================================================================
  // 1) Utilidades de estado (GM_getValue/GM_setValue com fallback JSON)
  // =========================================================================
  function getVal(key, def) {
    try {
      var raw = GM_getValue(key, undefined);
      if (raw === undefined) return def;
      if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch (e) { return raw; }
      }
      return raw;
    } catch (e) {
      return def;
    }
  }
  function setVal(key, val) {
    try { GM_setValue(key, JSON.stringify(val)); } catch (e) {}
  }

  function getFila() { return getVal(K.fila, []); }
  function getIndice() { return getVal(K.indice, 0); }
  function getResultados() { return getVal(K.resultados, []); }
  function isRodando() { return getVal(K.rodando, false) === true; }

  function setFila(v) { setVal(K.fila, v); }
  function setIndice(v) { setVal(K.indice, v); }
  function setResultados(v) { setVal(K.resultados, v); }
  function setRodando(v) { setVal(K.rodando, v === true); }
  function setUltimoStatus(v) { setVal(K.ultimoStatus, String(v || '')); }
  function getUltimoStatus() { return getVal(K.ultimoStatus, ''); }

  // =========================================================================
  // 2) Utilidades de CNPJ
  // =========================================================================
  function somenteDigitos(s) {
    return String(s == null ? '' : s).replace(/\D+/g, '');
  }

  function formatarCnpj(d) {
    d = somenteDigitos(d);
    if (d.length !== 14) return d;
    return d.slice(0, 2) + '.' + d.slice(2, 5) + '.' + d.slice(5, 8) +
      '/' + d.slice(8, 12) + '-' + d.slice(12, 14);
  }

  function cnpjValido(d) {
    d = somenteDigitos(d);
    if (d.length !== 14) return false;
    if (/^(\d)\1{13}$/.test(d)) return false; // todos iguais

    function calcDig(base) {
      var pesos = base.length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      var soma = 0;
      for (var i = 0; i < base.length; i++) {
        soma += parseInt(base.charAt(i), 10) * pesos[i];
      }
      var resto = soma % 11;
      return resto < 2 ? 0 : 11 - resto;
    }

    var base12 = d.slice(0, 12);
    var dv1 = calcDig(base12);
    if (dv1 !== parseInt(d.charAt(12), 10)) return false;
    var dv2 = calcDig(base12 + String(dv1));
    if (dv2 !== parseInt(d.charAt(13), 10)) return false;
    return true;
  }

  // =========================================================================
  // 3) Parsing de lista colada → fila limpa/validada/deduplicada
  // =========================================================================
  function parsearLista(texto) {
    var linhas = String(texto || '').split(/[\r\n,;]+/);
    var vistos = {};
    var fila = [];
    for (var i = 0; i < linhas.length; i++) {
      var d = somenteDigitos(linhas[i]);
      if (!d) continue;
      // Só entram com 14 dígitos; validade é checada na hora de processar
      if (d.length !== 14) {
        // guarda mesmo assim para reportar como inválido
        if (!vistos[d]) { vistos[d] = true; fila.push(d); }
        continue;
      }
      if (!vistos[d]) { vistos[d] = true; fila.push(d); }
    }
    return fila;
  }

  // =========================================================================
  // 4) Helpers de DOM
  // =========================================================================
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function xpath(expr) {
    try {
      var r = document.evaluate(expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue;
    } catch (e) { return null; }
  }

  function dispararEventos(el) {
    if (!el) return;
    ['input', 'change', 'keyup', 'blur'].forEach(function (t) {
      try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {}
    });
  }

  // Localiza o input de CNPJ com vários fallbacks
  // Site atual (Angular): <div id="alert-cnpj"><input maxlength="18" mask="AA.AAA.AAA/AAAA-AA"></div>
  // sem id/name no input — por isso o container #alert-cnpj é o seletor mais estável.
  function acharInputCnpj() {
    var cands = [
      '#alert-cnpj input',
      '#cnpj',
      'input[name="cnpj"]',
      'input[id*="cnpj" i]',
      'input[name*="cnpj" i]',
      'input[mask*="AAAA" i]',
      'input[maxlength="18"]',
      'input[maxlength="14"]'
    ];
    for (var i = 0; i < cands.length; i++) {
      var el = $(cands[i]);
      if (el && el.type !== 'hidden') return el;
    }
    // fallback: primeiro input de texto visível
    var inputs = $all('input[type="text"], input:not([type])');
    for (var j = 0; j < inputs.length; j++) {
      if (inputs[j].offsetParent !== null) return inputs[j];
    }
    return null;
  }

  // Localiza o botão "Consultar" com vários fallbacks
  function acharBotaoConsultar() {
    var direto = $('#salvar');
    if (direto) return direto;

    // por value/texto
    var botoes = $all('button, input[type="submit"], input[type="button"], a');
    for (var i = 0; i < botoes.length; i++) {
      var b = botoes[i];
      var txt = (b.value || b.textContent || '').trim().toLowerCase();
      if (/consultar/.test(txt)) return b;
    }
    // XPath fallback
    var xp = xpath("//*[self::button or self::input or self::a][contains(translate(normalize-space(.),'CONSULTAR','consultar'),'consultar') or contains(translate(@value,'CONSULTAR','consultar'),'consultar')]");
    if (xp) return xp;
    return null;
  }

  // No site atual, o botão "Consultar" vem com `disabled` até o CNPJ ser
  // válido e o captcha ser resolvido — clicar nele desabilitado não faz nada.
  function botaoHabilitado(btn) {
    return !!btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
  }

  // =========================================================================
  // 5) Detecção de captcha resolvido
  // =========================================================================
  function tokenCaptcha() {
    // hCaptcha e reCAPTCHA expõem um textarea com o token quando resolvidos
    var seletores = [
      'textarea[name="h-captcha-response"]',
      'textarea#h-captcha-response',
      'textarea[name="g-recaptcha-response"]',
      'textarea#g-recaptcha-response',
      'textarea[id^="h-captcha-response"]',
      'textarea[id^="g-recaptcha-response"]'
    ];
    for (var i = 0; i < seletores.length; i++) {
      var els = $all(seletores[i]);
      for (var j = 0; j < els.length; j++) {
        if (els[j].value && els[j].value.trim().length > 20) return els[j].value.trim();
      }
    }
    return null;
  }

  function existeCaptchaNaPagina() {
    return !!(
      $('.h-captcha') || $('.g-recaptcha') ||
      $('iframe[src*="hcaptcha"]') || $('iframe[src*="recaptcha"]') ||
      $('textarea[name="h-captcha-response"]') || $('textarea[name="g-recaptcha-response"]')
    );
  }

  // =========================================================================
  // 6) Extração de TODOS os campos do cartão CNPJ (comprovante)
  // =========================================================================
  // Campos do comprovante da Receita, na ordem em que aparecem. A ordem
  // importa: rótulos mais específicos vêm ANTES dos genéricos para não
  // haver captura errada (ex.: "DATA DA SITUAÇÃO CADASTRAL" antes de
  // "SITUAÇÃO CADASTRAL"; "NÚMERO DE INSCRIÇÃO" antes de "NÚMERO").
  var ROTULOS = [
    { chave: 'numero_inscricao',        re: /^n[uú]mero de inscri[çc][aã]o\b/i },
    { chave: 'data_abertura',           re: /^data de abertura\b/i },
    { chave: 'nome_empresarial',        re: /^nome empresarial\b/i },
    { chave: 'nome_fantasia',           re: /^t[ií]tulo do estabelecimento\b(\s*\(nome de fantasia\))?|^nome de fantasia\b|^nome fantasia\b/i },
    { chave: 'porte',                   re: /^porte\b/i },
    { chave: 'atividade_principal',     re: /^c[oó]digo e descri[çc][aã]o da atividade econ[oô]mica principal\b/i },
    { chave: 'atividades_secundarias',  re: /^c[oó]digo e descri[çc][aã]o das atividades econ[oô]micas secund[aá]rias\b/i },
    { chave: 'natureza_juridica',       re: /^c[oó]digo e descri[çc][aã]o da natureza jur[ií]dica\b/i },
    { chave: 'logradouro',              re: /^logradouro\b/i },
    { chave: 'numero_endereco',         re: /^n[uú]mero$/i },
    { chave: 'complemento',             re: /^complemento\b/i },
    { chave: 'cep',                     re: /^cep\b/i },
    { chave: 'bairro',                  re: /^bairro(\s*\/\s*distrito)?\b|^distrito\b/i },
    { chave: 'municipio',               re: /^munic[ií]pio\b/i },
    { chave: 'uf',                      re: /^uf\b/i },
    { chave: 'email',                   re: /^endere[çc]o eletr[oô]nico\b|^e-?mail\b/i },
    { chave: 'telefone',                re: /^telefone\b/i },
    { chave: 'efr',                     re: /^ente federativo respons[aá]vel\b(\s*\(efr\))?|\befr\b/i },
    { chave: 'data_situacao_cadastral', re: /^data da situa[çc][aã]o cadastral\b/i },
    { chave: 'motivo_situacao',         re: /^motivo de situa[çc][aã]o cadastral\b/i },
    { chave: 'situacao_cadastral',      re: /^situa[çc][aã]o cadastral\b/i },
    { chave: 'data_situacao_especial',  re: /^data da situa[çc][aã]o especial\b/i },
    { chave: 'situacao_especial',       re: /^situa[çc][aã]o especial\b/i }
  ];

  // Linhas de cabeçalho/rodapé do comprovante que não são campos.
  var IGNORAR_LINHA = [
    /rep[uú]blica federativa/i,
    /cadastro nacional da pessoa/i,
    /comprovante de inscri[çc][aã]o e de situa[çc][aã]o/i,
    /aprovado pela instru[çc][aã]o normativa/i,
    /emitido no dia/i,
    /^about:blank/i,
    /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}/ // timestamp "16/07/2026, 14:30"
  ];

  // Receita usa "****" / "********" para campos vazios.
  function ehPlaceholder(v) {
    var s = String(v || '').replace(/\s+/g, '');
    return !s || /^\*+$/.test(s) || s === '-';
  }

  function limparValor(v) {
    v = String(v == null ? '' : v).replace(/\s{2,}/g, ' ').trim();
    return ehPlaceholder(v) ? '' : v;
  }

  // Regex "corte": qualquer início de rótulo conhecido. Usada para truncar
  // valores que, num layout concatenado, arrastaram o rótulo seguinte junto
  // (ex.: "PINHEIRO UF" -> "PINHEIRO").
  var CORTE_ROTULOS = new RegExp(
    '\\s+(' + [
      'n[uú]mero de inscri', 'data de abertura', 'nome empresarial',
      't[ií]tulo do estabelecimento', 'porte\\b', 'c[oó]digo e descri',
      'natureza jur', 'logradouro', 'complemento', 'bairro', 'distrito',
      'munic[ií]pio', '\\buf\\b', 'endere[çc]o eletr', 'telefone',
      'ente federativo', '\\befr\\b', 'situa[çc][aã]o cadastral',
      'data da situa', 'motivo de situa', 'situa[çc][aã]o especial'
    ].join('|') + ').*$', 'i');

  // Percorre o innerText linha a linha, montando um mapa rótulo -> valor.
  // O comprovante da SPA renderiza cada rótulo e cada valor em elementos
  // próprios, então normalmente o valor está na(s) linha(s) seguinte(s) ao
  // rótulo (às vezes na mesma linha). O walker cobre os dois casos e ainda
  // agrega valores multi-linha (ex.: lista de atividades secundárias).
  function walkerTexto() {
    var texto = (document.body ? document.body.innerText : '') || '';
    var linhas = texto.split(/\r?\n/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length; });

    var mapa = {};
    var atual = null;
    for (var i = 0; i < linhas.length; i++) {
      var ln = linhas[i];

      var ignorar = false;
      for (var g = 0; g < IGNORAR_LINHA.length; g++) {
        if (IGNORAR_LINHA[g].test(ln)) { ignorar = true; break; }
      }
      if (ignorar) { atual = null; continue; }

      var rotulo = null, resto = '';
      for (var r = 0; r < ROTULOS.length; r++) {
        if (ROTULOS[r].re.test(ln)) {
          rotulo = ROTULOS[r].chave;
          resto = ln.replace(ROTULOS[r].re, '').replace(/^[\s:*\-|]+/, '').trim();
          break;
        }
      }

      if (rotulo) {
        atual = rotulo;
        if (!mapa[atual]) mapa[atual] = [];
        if (resto) mapa[atual].push(resto);
      } else if (atual) {
        mapa[atual].push(ln);
      }
    }

    function pegar(chave, sep) {
      var arr = mapa[chave] || [];
      return limparValor(arr.join(sep || ' '));
    }

    var dados = {
      numero_inscricao: '',
      matriz_filial: '',
      data_abertura: '',
      nome_empresarial: pegar('nome_empresarial'),
      nome_fantasia: pegar('nome_fantasia'),
      porte: pegar('porte'),
      atividade_principal: pegar('atividade_principal'),
      atividades_secundarias: pegar('atividades_secundarias', ' | '),
      natureza_juridica: pegar('natureza_juridica'),
      logradouro: pegar('logradouro'),
      numero_endereco: pegar('numero_endereco'),
      complemento: pegar('complemento'),
      cep: pegar('cep'),
      bairro: pegar('bairro'),
      municipio: pegar('municipio'),
      uf: pegar('uf').toUpperCase(),
      email: pegar('email'),
      telefone: pegar('telefone'),
      efr: pegar('efr'),
      situacao_cadastral: pegar('situacao_cadastral'),
      data_situacao_cadastral: pegar('data_situacao_cadastral'),
      motivo_situacao: pegar('motivo_situacao'),
      situacao_especial: pegar('situacao_especial'),
      data_situacao_especial: pegar('data_situacao_especial')
    };

    // --- Bloco do topo (nº de inscrição / matriz-filial / data de abertura) ---
    // Esse bloco costuma vir "bagunçado" no innerText (rótulos e valores
    // misturados), então extraímos por regex global no texto inteiro.
    var mCnpj = texto.match(/\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})\b/);
    if (mCnpj) dados.numero_inscricao = mCnpj[1];

    var mMF = texto.match(/\b(MATRIZ|FILIAL)\b/i);
    if (mMF) dados.matriz_filial = mMF[1].toUpperCase();

    // Data de abertura = 1ª data dd/mm/aaaa antes de "NOME EMPRESARIAL"
    // (ignora o timestamp de emissão, já filtrado, e as datas de situação).
    var topo = texto.split(/nome empresarial/i)[0] || texto;
    var mAbert = topo.match(/\b(\d{2}\/\d{2}\/\d{4})\b/);
    if (mAbert) dados.data_abertura = mAbert[1];

    return dados;
  }

  // Scan por proximidade no DOM: para cada rótulo conhecido, procura um
  // elemento cujo texto começa com o rótulo e extrai o valor adjacente
  // (mesmo mecanismo que já funcionava para Município/UF na v1). É a fonte
  // MAIS confiável no comprovante da SPA, pois usa a estrutura do DOM em vez
  // da linearização do innerText (que junta colunas na mesma linha).
  function scanDom() {
    var dom = {};
    var celulas = $all('td, th, span, div, font, b, strong, p, label, li');
    for (var c = 0; c < celulas.length; c++) {
      var t = (celulas[c].textContent || '').trim();
      if (!t) continue;
      for (var r = 0; r < ROTULOS.length; r++) {
        var chave = ROTULOS[r].chave;
        if (dom[chave]) continue; // já resolvido
        if (!ROTULOS[r].re.test(t)) continue;
        var val = limparValor(valorProximo(celulas[c], t, ROTULOS[r].re));
        if (val) dom[chave] = val;
        break; // este elemento pertence a este rótulo
      }
    }
    return dom;
  }

  // Combina DOM (primário) + walker de texto (fallback) + saneamentos.
  function extrairDadosCartao() {
    var texto = (document.body ? document.body.innerText : '') || '';
    var t = walkerTexto();
    var d = scanDom();

    // Campos de linha única: prefere DOM; corta rótulo vizinho que tenha
    // vazado num layout concatenado.
    function atomico(chave) {
      var v = d[chave] || t[chave] || '';
      return limparValor(String(v).replace(CORTE_ROTULOS, ''));
    }
    // Campos que podem ser multi-linha (listas): prefere o walker, que agrega.
    function bloco(chave) {
      return t[chave] || d[chave] || '';
    }

    var dados = {
      numero_inscricao: t.numero_inscricao || '',
      matriz_filial: t.matriz_filial || '',
      data_abertura: t.data_abertura || atomico('data_abertura'),
      nome_empresarial: atomico('nome_empresarial'),
      nome_fantasia: atomico('nome_fantasia'),
      porte: atomico('porte'),
      atividade_principal: bloco('atividade_principal'),
      atividades_secundarias: bloco('atividades_secundarias'),
      natureza_juridica: atomico('natureza_juridica'),
      logradouro: atomico('logradouro'),
      numero_endereco: atomico('numero_endereco'),
      complemento: atomico('complemento'),
      cep: atomico('cep'),
      bairro: atomico('bairro'),
      municipio: atomico('municipio'),
      uf: atomico('uf').toUpperCase(),
      email: atomico('email'),
      telefone: atomico('telefone'),
      efr: atomico('efr'),
      situacao_cadastral: atomico('situacao_cadastral'),
      data_situacao_cadastral: atomico('data_situacao_cadastral'),
      motivo_situacao: atomico('motivo_situacao'),
      situacao_especial: atomico('situacao_especial'),
      data_situacao_especial: atomico('data_situacao_especial')
    };

    // --- Saneamentos por regex (mais confiáveis) ---
    var mCnpj = texto.match(/\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})\b/);
    if (mCnpj) dados.numero_inscricao = mCnpj[1];

    if (!dados.matriz_filial) {
      var mMF = texto.match(/\b(MATRIZ|FILIAL)\b/i);
      if (mMF) dados.matriz_filial = mMF[1].toUpperCase();
    }

    // CEP: normaliza / recupera pelo padrão dd.ddd-ddd.
    var mCep = (dados.cep + ' ' + texto).match(/\b(\d{2}\.?\d{3}-\d{3})\b/);
    if (mCep) dados.cep = mCep[1];

    // UF: reduz a exatamente 2 letras.
    var mUf = (dados.uf || '').match(/\b([A-Z]{2})\b/);
    dados.uf = mUf ? mUf[1] : '';

    // Situação cadastral: isola a palavra-chave, sem arrastar data.
    var mSit = (dados.situacao_cadastral || '')
      .match(/\b(ATIVA|BAIXADA|INAPTA|SUSPENSA|NULA)\b/i);
    if (mSit) dados.situacao_cadastral = mSit[1].toUpperCase();

    // Compat: alias usado no restante do código.
    dados.cidade = dados.municipio;
    return dados;
  }

  // Dado um elemento que contém o rótulo, tenta achar o valor:
  // 1) texto após o rótulo no mesmo nó; 2) próximo irmão; 3) próxima célula.
  function valorProximo(el, textoRotulo, regexRotulo) {
    // caso o valor esteja no mesmo texto: "MUNICÍPIO SAO PAULO"
    var m = textoRotulo.replace(regexRotulo, '').replace(/^[\s:*-]+/, '').trim();
    if (m) return m;

    // irmão seguinte
    var sib = el.nextElementSibling;
    while (sib) {
      var st = (sib.textContent || '').trim();
      if (st) return st;
      sib = sib.nextElementSibling;
    }
    // célula seguinte (tabela)
    var td = el.closest ? el.closest('td, th') : null;
    if (td && td.nextElementSibling) {
      var nt = (td.nextElementSibling.textContent || '').trim();
      if (nt) return nt;
    }
    return '';
  }

  // Classifica um texto de erro em um status conhecido.
  function classificarErro(texto) {
    var t = (texto || '').toLowerCase();
    if (/n[aã]o\s+existe|inexistente|n[aã]o\s+foi\s+localizad|n[aã]o\s+encontrad/.test(t)) {
      return { status: 'nao_encontrado', mensagem: (texto || '').trim() || 'CNPJ não encontrado / inexistente.' };
    }
    if (/captcha|verifica[çc][aã]o|anti-?rob[oô]/.test(t) &&
        /inv[aá]lid|incorret|errad|expir|novamente/.test(t)) {
      return { status: 'captcha_falhou', mensagem: (texto || '').trim() || 'Captcha/verificação inválida.' };
    }
    return { status: 'erro', mensagem: (texto || '').trim() || 'Erro desconhecido ao consultar.' };
  }

  // Detecta páginas de erro / CNPJ inexistente no comprovante ou solicitação
  function detectarErroPagina() {
    var texto = (document.body ? document.body.innerText : '') || '';
    var tl = texto.toLowerCase();
    if (/n[aã]o\s+existe|inexistente|n[aã]o\s+foi\s+localizad|n[aã]o\s+encontrad/.test(tl)) {
      return classificarErro(texto.match(/.{0,40}(n[aã]o\s+existe|inexistente|n[aã]o\s+foi\s+localizad|n[aã]o\s+encontrad).{0,40}/i)[0]);
    }
    if (/captcha|verifica[çc][aã]o|anti-?rob[oô]/.test(tl) && /inv[aá]lid|incorret|errad|expir/.test(tl)) {
      return classificarErro(texto.match(/.{0,40}(captcha|verifica[çc][aã]o|anti-?rob[oô]).{0,60}/i)[0]);
    }
    return null;
  }

  // =========================================================================
  // 7) UI — painel flutuante
  // =========================================================================
  var UI = {};

  function criarPainel() {
    if (document.getElementById('cnpjbot-panel')) return;

    var wrap = document.createElement('div');
    wrap.id = 'cnpjbot-panel';
    wrap.innerHTML = [
      '<div id="cnpjbot-head">',
      '  <span id="cnpjbot-title">🤖 Bot CNPJ → Cartão completo</span>',
      '  <span id="cnpjbot-min" title="Minimizar">—</span>',
      '</div>',
      '<div id="cnpjbot-body">',
      '  <textarea id="cnpjbot-input" placeholder="Cole os CNPJs aqui (um por linha)..."></textarea>',
      '  <div id="cnpjbot-btns">',
      '    <button id="cnpjbot-iniciar">▶ Iniciar</button>',
      '    <button id="cnpjbot-parar">⏸ Parar</button>',
      '    <button id="cnpjbot-limpar">🗑 Limpar</button>',
      '    <button id="cnpjbot-csv">⬇ Baixar CSV</button>',
      '  </div>',
      '  <div id="cnpjbot-progress">Ocioso.</div>',
      '  <div id="cnpjbot-log"></div>',
      '</div>'
    ].join('');
    document.body.appendChild(wrap);

    injetarEstilos();

    UI.wrap = wrap;
    UI.input = document.getElementById('cnpjbot-input');
    UI.progress = document.getElementById('cnpjbot-progress');
    UI.log = document.getElementById('cnpjbot-log');

    document.getElementById('cnpjbot-iniciar').addEventListener('click', aoIniciar);
    document.getElementById('cnpjbot-parar').addEventListener('click', aoParar);
    document.getElementById('cnpjbot-limpar').addEventListener('click', aoLimpar);
    document.getElementById('cnpjbot-csv').addEventListener('click', baixarCsv);
    document.getElementById('cnpjbot-min').addEventListener('click', function () {
      var b = document.getElementById('cnpjbot-body');
      b.style.display = b.style.display === 'none' ? 'block' : 'none';
    });

    tornarArrastavel(wrap, document.getElementById('cnpjbot-head'));

    // Reflete estado persistido
    var fila = getFila();
    if (fila.length && UI.input && !UI.input.value) {
      UI.input.value = fila.map(formatarCnpj).join('\n');
    }
    atualizarProgresso();
  }

  function injetarEstilos() {
    if (document.getElementById('cnpjbot-style')) return;
    var css = document.createElement('style');
    css.id = 'cnpjbot-style';
    css.textContent = [
      '#cnpjbot-panel{position:fixed;top:12px;right:12px;width:320px;z-index:2147483647;',
      'font-family:Segoe UI,Arial,sans-serif;font-size:13px;background:#1f2937;color:#f9fafb;',
      'border:1px solid #374151;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);overflow:hidden;}',
      '#cnpjbot-head{display:flex;justify-content:space-between;align-items:center;',
      'background:#111827;padding:8px 10px;cursor:move;user-select:none;}',
      '#cnpjbot-title{font-weight:600;}',
      '#cnpjbot-min{cursor:pointer;padding:0 6px;font-weight:700;}',
      '#cnpjbot-body{padding:10px;}',
      '#cnpjbot-input{width:100%;height:90px;box-sizing:border-box;resize:vertical;',
      'border-radius:6px;border:1px solid #4b5563;background:#111827;color:#f9fafb;padding:6px;font-family:monospace;}',
      '#cnpjbot-btns{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;}',
      '#cnpjbot-btns button{flex:1 1 46%;cursor:pointer;border:none;border-radius:6px;',
      'padding:7px 6px;font-size:12px;font-weight:600;color:#fff;background:#2563eb;}',
      '#cnpjbot-btns button:hover{filter:brightness(1.1);}',
      '#cnpjbot-parar{background:#b45309!important;}',
      '#cnpjbot-limpar{background:#6b7280!important;}',
      '#cnpjbot-csv{background:#059669!important;}',
      '#cnpjbot-progress{background:#111827;border-radius:6px;padding:7px;margin-bottom:6px;',
      'font-size:12px;line-height:1.4;white-space:pre-wrap;}',
      '#cnpjbot-log{max-height:120px;overflow:auto;font-family:monospace;font-size:11px;',
      'background:#0b1220;border-radius:6px;padding:6px;color:#cbd5e1;}',
      '#cnpjbot-log div{padding:1px 0;border-bottom:1px solid rgba(255,255,255,.04);}'
    ].join('');
    document.head.appendChild(css);
  }

  function tornarArrastavel(box, handle) {
    var ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', function (e) {
      if (e.target.id === 'cnpjbot-min') return;
      dragging = true;
      var r = box.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      box.style.left = (e.clientX - ox) + 'px';
      box.style.top = (e.clientY - oy) + 'px';
      box.style.right = 'auto';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  }

  function logar(msg) {
    if (!UI.log) return;
    var d = document.createElement('div');
    var hora = new Date().toLocaleTimeString();
    d.textContent = '[' + hora + '] ' + msg;
    UI.log.appendChild(d);
    UI.log.scrollTop = UI.log.scrollHeight;
  }

  function atualizarProgresso(extra) {
    if (!UI.progress) return;
    var fila = getFila();
    var idx = getIndice();
    var res = getResultados();
    var rodando = isRodando();
    var atual = fila[idx] ? formatarCnpj(fila[idx]) : '—';
    var linhas = [];
    linhas.push('Estado: ' + (rodando ? '▶ rodando' : (idx >= fila.length && fila.length ? '✔ concluído' : '⏸ parado')));
    linhas.push('Progresso: ' + Math.min(idx, fila.length) + '/' + fila.length);
    if (rodando) linhas.push('Atual: ' + atual);
    linhas.push('Coletados: ' + res.length);
    if (getUltimoStatus()) linhas.push('Último: ' + getUltimoStatus());
    if (extra) linhas.push(extra);
    UI.progress.textContent = linhas.join('\n');
  }

  // =========================================================================
  // 8) Handlers dos botões
  // =========================================================================
  function aoIniciar() {
    var fila = parsearLista(UI.input.value);
    if (!fila.length) {
      alert('Cole ao menos um CNPJ na caixa de texto.');
      return;
    }
    setFila(fila);
    setIndice(0);
    setResultados([]);
    setRodando(true);
    setUltimoStatus('');
    setVal(K.aguardandoComprovante, false);
    setVal(K.errosSeguidos, 0);
    logar('Iniciando: ' + fila.length + ' CNPJ(s) na fila.');
    atualizarProgresso();
    // Se não estivermos no formulário de solicitação, vai para ele
    if (estaNoComprovante()) {
      location.href = URL_SOLICITACAO;
    } else {
      passoSolicitacao();
    }
  }

  function aoParar() {
    setRodando(false);
    logar('Pausado pelo usuário.');
    atualizarProgresso();
  }

  function aoLimpar() {
    if (!confirm('Limpar fila, resultados e progresso?')) return;
    setRodando(false);
    setFila([]);
    setIndice(0);
    setResultados([]);
    setUltimoStatus('');
    setVal(K.aguardandoComprovante, false);
    setVal(K.errosSeguidos, 0);
    if (UI.input) UI.input.value = '';
    logar('Estado limpo.');
    atualizarProgresso();
  }

  // =========================================================================
  // 9) Máquina de estados por página
  // =========================================================================
  var pollTimer = null;
  var pollInicio = 0;

  function pararPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function proximoCnpj(status, mensagem, dados) {
    var fila = getFila();
    var idx = getIndice();
    var cnpj = fila[idx];
    var res = getResultados();
    dados = dados || {};
    res.push({
      cnpj: cnpj,
      status: status,
      mensagem: mensagem || '',
      // Todos os campos do cartão CNPJ
      numero_inscricao: dados.numero_inscricao || '',
      matriz_filial: dados.matriz_filial || '',
      data_abertura: dados.data_abertura || '',
      nome_empresarial: dados.nome_empresarial || '',
      nome_fantasia: dados.nome_fantasia || '',
      porte: dados.porte || '',
      atividade_principal: dados.atividade_principal || '',
      atividades_secundarias: dados.atividades_secundarias || '',
      natureza_juridica: dados.natureza_juridica || '',
      logradouro: dados.logradouro || '',
      numero_endereco: dados.numero_endereco || '',
      complemento: dados.complemento || '',
      cep: dados.cep || '',
      bairro: dados.bairro || '',
      // aliases mantidos p/ compatibilidade
      cidade: dados.municipio || '',
      estado: dados.uf || '',
      municipio: dados.municipio || '',
      uf: dados.uf || '',
      email: dados.email || '',
      telefone: dados.telefone || '',
      efr: dados.efr || '',
      situacao_cadastral: dados.situacao_cadastral || '',
      data_situacao_cadastral: dados.data_situacao_cadastral || '',
      motivo_situacao: dados.motivo_situacao || '',
      situacao_especial: dados.situacao_especial || '',
      data_situacao_especial: dados.data_situacao_especial || ''
    });
    setResultados(res);
    setUltimoStatus(formatarCnpj(cnpj) + ' → ' + status +
      (dados.municipio ? ' (' + dados.municipio + '/' + (dados.uf || '') + ')' : ''));
    var novoIndice = idx + 1;
    setIndice(novoIndice);
    setVal(K.aguardandoComprovante, false);
    logar(formatarCnpj(cnpj) + ': ' + status + (mensagem ? ' — ' + mensagem : ''));

    // Backoff: falhas de comunicação/captcha seguidas indicam bloqueio ou
    // instabilidade no servidor — melhor parar do que insistir.
    var falhaServidor = (status === 'captcha_falhou' || status === 'erro');
    var erros = falhaServidor ? (getVal(K.errosSeguidos, 0) + 1) : 0;
    setVal(K.errosSeguidos, erros);

    if (erros >= MAX_ERROS_SEGUIDOS) {
      setRodando(false);
      logar('⚠ ' + erros + ' falhas seguidas. Pausando para não insistir contra o servidor.');
      atualizarProgresso('Pausado por falhas seguidas — revise e clique Iniciar para retomar.');
      return;
    }

    // Pausa longa periódica, mesmo em sequência de sucessos.
    if (novoIndice > 0 && novoIndice % PAUSA_A_CADA_N === 0 && novoIndice < fila.length) {
      logar('⏳ Pausa de ' + Math.round(PAUSA_LONGA_MS / 1000) + 's a cada ' + PAUSA_A_CADA_N + ' consultas (evitar volume excessivo).');
      atualizarProgresso('Pausa programada (' + Math.round(PAUSA_LONGA_MS / 1000) + 's)…');
      setTimeout(function () {
        if (!isRodando()) return;
        location.href = URL_SOLICITACAO;
      }, PAUSA_LONGA_MS);
      return;
    }

    // Intervalo aleatório entre consultas para não martelar o servidor em
    // ritmo fixo/robótico.
    var espera = delayAleatorio();
    atualizarProgresso('Aguardando ' + Math.round(espera / 1000) + 's antes do próximo…');
    setTimeout(function () {
      if (!isRodando()) return;
      location.href = URL_SOLICITACAO;
    }, espera);
  }

  function concluir() {
    setRodando(false);
    var res = getResultados();
    logar('✔ Concluído. ' + res.length + ' CNPJ(s) processados.');
    atualizarProgresso('Clique em "Baixar CSV".');
  }

  // -- Página de SOLICITAÇÃO --
  function passoSolicitacao() {
    if (!isRodando()) return;
    var fila = getFila();
    var idx = getIndice();

    if (idx >= fila.length) { concluir(); return; }

    var cnpj = fila[idx];

    // Pula inválidos sem gastar consulta
    if (!cnpjValido(cnpj)) {
      logar(formatarCnpj(cnpj) + ': inválido (dígitos verificadores). Pulando.');
      proximoCnpj('invalido', 'CNPJ inválido (falha na validação dos dígitos).');
      return;
    }

    var input = acharInputCnpj();
    if (!input) {
      logar('Não achei o campo de CNPJ. Tentando novamente em 1s...');
      setTimeout(passoSolicitacao, 1000);
      return;
    }

    // Preenche o CNPJ (com máscara — o site normalmente aceita)
    input.focus();
    input.value = formatarCnpj(cnpj);
    dispararEventos(input);
    logar('Preenchido: ' + formatarCnpj(cnpj) + '. Marque o captcha, por favor.');
    atualizarProgresso('Aguardando você marcar o captcha…');

    // Aguarda captcha resolvido E o botão "Consultar" ficar habilitado
    // (no site atual ele vem com `disabled` até ambas as condições valerem).
    pararPoll();
    pollInicio = Date.now();
    pollTimer = setInterval(function () {
      if (!isRodando()) { pararPoll(); return; }

      var tk = tokenCaptcha();
      var semCaptchaNaPagina = !existeCaptchaNaPagina() && (Date.now() - pollInicio) > 4000;

      if (tk || semCaptchaNaPagina) {
        var botao = acharBotaoConsultar();
        if (botao && botaoHabilitado(botao)) {
          pararPoll();
          logar(tk ? 'Captcha detectado. Clicando em Consultar…' : 'Sem captcha detectável — tentando Consultar direto.');
          atualizarProgresso('Consultando…');
          setVal(K.aguardandoComprovante, true);
          setTimeout(function () {
            botao.click();
            aguardarResultadoAposClique();
          }, 300);
          return;
        }
        // token presente mas botão ainda desabilitado (Angular ainda
        // validando) — segue no polling até habilitar.
      }

      if ((Date.now() - pollInicio) > CAPTCHA_TIMEOUT_MS) {
        pararPoll();
        logar('Tempo esgotado aguardando o captcha. Pausando.');
        setRodando(false);
        atualizarProgresso('Tempo esgotado — clique Iniciar para retomar.');
      }
    }, CAPTCHA_POLL_MS);
  }

  // Após clicar em "Consultar", o site atual (SPA Angular) troca o conteúdo
  // sem recarregar a página — então não dá para contar com o Tampermonkey
  // reinjetando o script numa "nova página". Em vez disso, ficamos
  // observando a própria página até a URL mudar para /comprovante OU até
  // aparecer uma mensagem de erro no formulário (captcha recusado, etc.).
  var pollResultado = null;

  function aguardarResultadoAposClique() {
    if (pollResultado) { clearInterval(pollResultado); pollResultado = null; }
    var inicio = Date.now();
    var alertInicial = $('#alert-cnpj');
    var classeInicial = alertInicial ? alertInicial.className : '';

    pollResultado = setInterval(function () {
      if (!isRodando()) { clearInterval(pollResultado); pollResultado = null; return; }

      if (estaNoComprovante()) {
        clearInterval(pollResultado); pollResultado = null;
        passoComprovante();
        return;
      }

      // Mensagem de erro apareceu no próprio formulário (sem navegar).
      var alertAgora = $('#alert-cnpj');
      var msgContainer = $('app-message-container');
      var alertMudou = alertAgora && classeInicial !== alertAgora.className &&
        /alert-danger|alert-warning/i.test(alertAgora.className);
      var temMensagem = msgContainer && (msgContainer.textContent || '').trim().length > 0;

      if (alertMudou || temMensagem) {
        clearInterval(pollResultado); pollResultado = null;
        var texto = ((alertAgora ? alertAgora.textContent : '') + ' ' + (msgContainer ? msgContainer.textContent : '')).trim();
        var erro = classificarErro(texto);
        proximoCnpj(erro.status, erro.mensagem);
        return;
      }

      if ((Date.now() - inicio) > RESULTADO_TIMEOUT_MS) {
        clearInterval(pollResultado); pollResultado = null;
        logar('Tempo esgotado aguardando resposta após clicar em Consultar.');
        proximoCnpj('erro', 'Tempo esgotado aguardando resposta da consulta.');
      }
    }, RESULTADO_POLL_MS);
  }

  // -- Página/estado de COMPROVANTE --
  function passoComprovante() {
    if (!isRodando()) return;

    // dá um tempinho para o Angular terminar de renderizar
    setTimeout(function () {
      var erro = detectarErroPagina();
      if (erro) {
        proximoCnpj(erro.status, erro.mensagem);
        return;
      }

      var dados = extrairDadosCartao();
      // Considera sucesso se conseguimos ao menos o nome empresarial ou o
      // município (indicadores de que o comprovante foi realmente lido).
      if (dados.nome_empresarial || dados.municipio || dados.numero_inscricao) {
        var resumo = dados.nome_empresarial ||
          (dados.municipio ? dados.municipio + '/' + dados.uf : '');
        proximoCnpj('sucesso', resumo, dados);
      } else {
        // pode ser página intermediária/erro genérico
        logar('Não consegui extrair os dados do comprovante. Registrando erro.');
        proximoCnpj('erro', 'Não foi possível extrair os dados do comprovante.');
      }
    }, 600);
  }

  // =========================================================================
  // 10) Exportar CSV
  // =========================================================================
  function csvEscapar(v) {
    v = String(v == null ? '' : v);
    if (/[";\n\r]/.test(v)) {
      v = '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  }

  // Colunas do CSV: rótulo (cabeçalho) + função que extrai o valor do registro.
  var COLUNAS_CSV = [
    ['CNPJ', function (r) { return formatarCnpj(r.cnpj); }],
    ['Matriz/Filial', function (r) { return r.matriz_filial; }],
    ['Data de Abertura', function (r) { return r.data_abertura; }],
    ['Nome Empresarial', function (r) { return r.nome_empresarial; }],
    ['Nome Fantasia', function (r) { return r.nome_fantasia; }],
    ['Porte', function (r) { return r.porte; }],
    ['Atividade Principal', function (r) { return r.atividade_principal; }],
    ['Atividades Secundárias', function (r) { return r.atividades_secundarias; }],
    ['Natureza Jurídica', function (r) { return r.natureza_juridica; }],
    ['Logradouro', function (r) { return r.logradouro; }],
    ['Número', function (r) { return r.numero_endereco; }],
    ['Complemento', function (r) { return r.complemento; }],
    ['CEP', function (r) { return r.cep; }],
    ['Bairro/Distrito', function (r) { return r.bairro; }],
    ['Município', function (r) { return r.municipio || r.cidade; }],
    ['UF', function (r) { return r.uf || r.estado; }],
    ['Endereço Eletrônico', function (r) { return r.email; }],
    ['Telefone', function (r) { return r.telefone; }],
    ['EFR', function (r) { return r.efr; }],
    ['Situação Cadastral', function (r) { return r.situacao_cadastral; }],
    ['Data Situação Cadastral', function (r) { return r.data_situacao_cadastral; }],
    ['Motivo Situação Cadastral', function (r) { return r.motivo_situacao; }],
    ['Situação Especial', function (r) { return r.situacao_especial; }],
    ['Data Situação Especial', function (r) { return r.data_situacao_especial; }],
    ['Status', function (r) { return r.status; }],
    ['Mensagem', function (r) { return r.mensagem; }]
  ];

  function montarCsv() {
    var res = getResultados();
    var linhas = [COLUNAS_CSV.map(function (c) { return csvEscapar(c[0]); }).join(';')];
    for (var i = 0; i < res.length; i++) {
      var r = res[i];
      linhas.push(COLUNAS_CSV.map(function (c) {
        return csvEscapar(c[1](r));
      }).join(';'));
    }
    return '﻿' + linhas.join('\r\n'); // BOM UTF-8 p/ Excel
  }

  function baixarCsv() {
    var res = getResultados();
    if (!res.length) {
      alert('Nada para exportar ainda.');
      return;
    }
    var conteudo = montarCsv();
    var nome = 'cnpj_cartao_completo_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
    var blob = new Blob([conteudo], { type: 'text/csv;charset=utf-8' });

    // Tenta GM_download; fallback para <a download>
    try {
      if (typeof GM_download === 'function') {
        var url = URL.createObjectURL(blob);
        GM_download({
          url: url,
          name: nome,
          saveAs: true,
          onload: function () { URL.revokeObjectURL(url); },
          onerror: function () { fallbackDownload(blob, nome); URL.revokeObjectURL(url); }
        });
        logar('CSV gerado: ' + nome);
        return;
      }
    } catch (e) { /* cai no fallback */ }

    fallbackDownload(blob, nome);
    logar('CSV gerado: ' + nome);
  }

  function fallbackDownload(blob, nome) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  }

  // =========================================================================
  // 11) Bootstrap — decide o passo pela URL atual
  // =========================================================================
  function iniciar() {
    if (!document.body) {
      setTimeout(iniciar, 200);
      return;
    }
    criarPainel();

    if (estaNoComprovante()) {
      if (isRodando()) passoComprovante();
    } else {
      // qualquer outra página dentro de /Servicos/cnpjreva/ é tratada como
      // o formulário de solicitação (é a única outra rota da SPA).
      if (isRodando()) passoSolicitacao();
    }
  }

  iniciar();
})();
