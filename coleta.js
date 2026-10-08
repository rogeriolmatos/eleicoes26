#!/usr/bin/env node
/**
 * coleta.js — robô de coleta do "Clima 2º Turno – Eleições 2026"
 *
 * Roda no GitHub Actions (Node 20+, sem dependências externas).
 * 1. Lê a CONFIGURAÇÃO dos candidatos direto do index.html (fonte única).
 * 2. Lê os feeds RSS de config/fontes.json, filtra as manchetes sobre a
 *    disputa presidencial, conta menções e classifica o tom (análise léxica).
 * 3. Valida a tabela de pesquisas (config/pesquisas.json): só entram
 *    pesquisas com número de registro no TSE.
 * 4. Copia a linha do tempo e a análise editorial.
 * 5. Busca os JSONs públicos do TSE: 1º turno por UF (para o mapa) e, a
 *    partir das 17h de 25/10, a apuração do 2º turno ao vivo (espelho).
 * 6. Grava dados.json. Se algo falhar, mantém o último dado válido.
 *
 * Variáveis de ambiente opcionais:
 *   FORCAR_APURACAO=1   busca a apuração do 2º turno mesmo fora do dia
 *   SEM_REDE=1          não acessa a internet (útil para testes locais)
 *   FEEDS_LOCAIS=pasta  lê arquivos XML locais (nome-da-fonte.xml) em vez da rede
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = __dirname;
const ARQ = {
  html: path.join(RAIZ, 'index.html'),
  dados: path.join(RAIZ, 'dados.json'),
  fontes: path.join(RAIZ, 'config', 'fontes.json'),
  pesquisas: path.join(RAIZ, 'config', 'pesquisas.json'),
  linha: path.join(RAIZ, 'config', 'linha-do-tempo.json'),
  analise: path.join(RAIZ, 'config', 'analise.json'),
};

const AGORA = new Date();
const TIMEOUT_MS = 15000;
const UA = 'Clima2Turno-Bot/1.0 (agregador independente de noticias; GitHub Actions)';
const SEM_REDE = process.env.SEM_REDE === '1';
const FEEDS_LOCAIS = process.env.FEEDS_LOCAIS || '';

const UFS = ['ac', 'al', 'ap', 'am', 'ba', 'ce', 'df', 'es', 'go', 'ma', 'mt', 'ms', 'mg', 'pa', 'pb',
  'pr', 'pe', 'pi', 'rj', 'rn', 'rs', 'ro', 'rr', 'sc', 'sp', 'se', 'to', 'zz'];

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function log(...a) { console.log('[coleta]', ...a); }

function lerJSON(arquivo, padrao) {
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); }
  catch (e) { if (padrao === undefined) throw e; return padrao; }
}

function gravarJSON(arquivo, obj) {
  const tmp = arquivo + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n', 'utf8');
  fs.renameSync(tmp, arquivo);
}

/** Lê o bloco CONFIG do index.html (entre os marcadores) sem executar o resto da página. */
function lerConfig() {
  const html = fs.readFileSync(ARQ.html, 'utf8');
  const ini = html.indexOf('/* ===== CONFIG:INICIO ===== */');
  const fim = html.indexOf('/* ===== CONFIG:FIM ===== */');
  if (ini < 0 || fim < 0) throw new Error('Marcadores CONFIG:INICIO / CONFIG:FIM não encontrados no index.html');
  const codigo = html.slice(ini, fim);
  return vm.runInNewContext(codigo + '\n;CONFIG', {}, { timeout: 1000 });
}

/** Normaliza texto para comparação: minúsculas, sem acentos, espaços simples. */
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Converte números no formato do TSE ("1.234,56", "50,90", "472075") em Number. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const ENTIDADES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', laquo: '«', raquo: '»', ordm: 'º', ordf: 'ª', deg: '°',
  aacute: 'á', Aacute: 'Á', agrave: 'à', Agrave: 'À', acirc: 'â', Acirc: 'Â', atilde: 'ã', Atilde: 'Ã',
  eacute: 'é', Eacute: 'É', ecirc: 'ê', Ecirc: 'Ê', iacute: 'í', Iacute: 'Í',
  oacute: 'ó', Oacute: 'Ó', ocirc: 'ô', Ocirc: 'Ô', otilde: 'õ', Otilde: 'Õ',
  uacute: 'ú', Uacute: 'Ú', uuml: 'ü', ccedil: 'ç', Ccedil: 'Ç',
};

function decodificarEntidades(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cod = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cod); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(ENTIDADES, e) ? ENTIDADES[e] : m;
  });
}

/** Remove CDATA, tags HTML e entidades; devolve texto limpo. */
function limpar(s) {
  if (!s) return '';
  let t = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  t = decodificarEntidades(t);            // entidades podem esconder tags (&lt;p&gt;)
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodificarEntidades(t);
  return t.replace(/\s+/g, ' ').trim();
}

function cortar(s, max) {
  if (!s || s.length <= max) return s || '';
  const c = s.slice(0, max);
  const esp = c.lastIndexOf(' ');
  return (esp > max * 0.6 ? c.slice(0, esp) : c).replace(/[\s,.;:–—-]+$/, '') + '…';
}

function dataValida(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ------------------------------------------------------------------ */
/* Rede                                                                */
/* ------------------------------------------------------------------ */

async function baixar(url, { tipo = 'texto', timeout = TIMEOUT_MS } = {}) {
  if (SEM_REDE) throw new Error('rede desativada (SEM_REDE=1)');
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': tipo === 'json' ? 'application/json' : 'application/rss+xml, application/xml, text/xml, */*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (tipo === 'json') return JSON.parse(buf.toString('utf8'));
  return decodificarBuffer(buf, r.headers.get('content-type') || '');
}

/** Respeita o charset declarado (há feeds em ISO-8859-1). */
function decodificarBuffer(buf, contentType) {
  let charset = (contentType.match(/charset=([\w-]+)/i) || [])[1];
  if (!charset) {
    const inicio = buf.subarray(0, 300).toString('latin1');
    charset = (inicio.match(/encoding=["']([\w-]+)["']/i) || [])[1];
  }
  charset = (charset || 'utf-8').toLowerCase();
  try { return new TextDecoder(charset).decode(buf); }
  catch { return buf.toString('utf8'); }
}

async function emLotes(itens, tamanho, fn) {
  const saida = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    const lote = itens.slice(i, i + tamanho);
    saida.push(...await Promise.all(lote.map(fn)));
  }
  return saida;
}

/* ------------------------------------------------------------------ */
/* RSS / Atom                                                          */
/* ------------------------------------------------------------------ */

function pegarTag(bloco, nome) {
  const n = nome.replace(':', '\\:');
  const re = new RegExp('<' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + n + '>', 'i');
  const m = bloco.match(re);
  return m ? m[1] : '';
}

function extrairItens(xml) {
  const blocos = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocos.map((b) => {
    let link = limpar(pegarTag(b, 'link'));
    if (!link) {
      const m = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = m ? decodificarEntidades(m[1]) : '';
    }
    if (!link) link = limpar(pegarTag(b, 'guid'));
    const desc = pegarTag(b, 'description') || pegarTag(b, 'summary') || pegarTag(b, 'content:encoded') || pegarTag(b, 'content');
    const data = pegarTag(b, 'pubDate') || pegarTag(b, 'dc:date') || pegarTag(b, 'published') || pegarTag(b, 'updated');
    return {
      titulo: limpar(pegarTag(b, 'title')),
      link: link.trim(),
      resumo: limpar(desc),
      data: limpar(data),
      fonteItem: limpar(pegarTag(b, 'source')),
    };
  }).filter((i) => i.titulo && /^https?:\/\//i.test(i.link));
}

/* ------------------------------------------------------------------ */
/* Menções e tom                                                       */
/* ------------------------------------------------------------------ */

function prepararDetector(candidatos) {
  return candidatos.map((c) => ({
    numero: String(c.numero),
    excluir: (c.excluir || []).map(norm),
    padroes: (c.apelidos || [c.nome]).map(norm).map((a) =>
      new RegExp('(^|[^a-z0-9])' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[^a-z0-9]|$)')),
  }));
}

function mencoes(textoNorm, detector) {
  const achados = [];
  for (const d of detector) {
    let t = textoNorm;
    for (const ex of d.excluir) t = t.split(ex).join(' ');
    if (d.padroes.some((re) => re.test(t))) achados.push(d.numero);
  }
  return achados;
}

/* Léxico simples em português (radicais sem acento). Ver limitações na página. */
const LEXICO_POS = ['lider', 'vence', 'vencer', 'venceu', 'vitori', 'avanc', 'cresce', 'cresci', 'ganha', 'ganho',
  'apoio', 'apoia', 'conquist', 'favorit', 'aprova', 'elogi', 'celebr', 'comemor', 'supera', 'amplia', 'sobe',
  'subiu', 'fortalec', 'consolid', 'recupera', 'aplaud', 'reforc', 'adesao', 'aliad', 'acordo', 'endoss',
  'melhora', 'empolg', 'otimis', 'mobiliz', 'destaque', 'sucesso', 'acerta'];
const LEXICO_NEG = ['perde', 'perdeu', 'cai ', 'caiu', 'queda', 'recua', 'recuo', 'critic', 'ataque', 'ataca',
  'acus', 'denunc', 'escandal', 'investig', 'polemic', 'crise', 'fraude', 'mentir', 'fake', 'derrota', 'rejeic',
  'rejeit', 'condena', 'inelegiv', 'prisao', 'preso', 'ameac', 'golpe', 'corrup', 'rombo', 'desgast', 'isolad',
  'racha', 'fracass', 'erro', 'gafe', 'contradi', 'process', 'multa', 'censur', 'violen', 'agress', 'ofend',
  'ofens', 'irregular', 'suspeit', 'tensao', 'briga', 'desvio', 'pior', 'piora', 'abandon', 'vaia', 'protest',
  'xing', 'insult', 'impugn', 'cassa', 'mentira', 'desinforma', 'manipula', 'tumult', 'conflit', 'panico'];
const NEGADORES = new Set(['nao', 'nem', 'jamais', 'nunca', 'sem']);

function classificarTom(textoNorm) {
  const tokens = textoNorm.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  let pos = 0; let neg = 0;
  tokens.forEach((tok, i) => {
    const negado = i > 0 && NEGADORES.has(tokens[i - 1]);
    const ehPos = LEXICO_POS.some((r) => tok.startsWith(r.trim()));
    const ehNeg = LEXICO_NEG.some((r) => (r.endsWith(' ') ? tok === r.trim() : tok.startsWith(r)));
    if (ehPos) negado ? neg++ : pos++;
    if (ehNeg) negado ? pos++ : neg++;
  });
  const saldo = pos - neg;
  return { tom: saldo > 0 ? 'positivo' : saldo < 0 ? 'negativo' : 'neutro', pos, neg };
}

const STOPWORDS = new Set(('a o e de da do das dos em no na nos nas um uma uns umas para por pelo pela pelos pelas com sem ' +
  'que se ao aos as os ou mas mais menos como sobre entre ate apos antes depois contra sua seu suas seus ele ela eles elas ' +
  'isso esse essa este esta aquele aquela ja nao sim tambem quando onde quem qual quais ha foi sao ser ter tem vai vao diz ' +
  'dizem afirma afirmou disse diz pode podem deve devem fazer faz fez ver veja saiba entenda video ao vivo hoje ontem ' +
  'amanha agora ano anos dia dias semana mes novo nova novos novas sobre segundo turno 2o 2º eleicao eleicoes 2026 ' +
  'presidente presidencial candidato candidatos campanha voto votos lula flavio bolsonaro luiz inacio silva senador ' +
  'brasil pt pl apos durante ainda muito muita todos todas cada outro outra outros outras seja sera serao estao esta ' +
  'pra pro vs x the of and minuto minutos noticias politica').split(/\s+/));

function contarTermos(titulos, limite = 40) {
  const cont = new Map();
  const forma = new Map();
  for (const t of titulos) {
    const brutos = String(t).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/);
    for (const b of brutos) {
      const limpo = b.replace(/^-+|-+$/g, '');
      const n = norm(limpo);
      if (n.length < 4 || STOPWORDS.has(n) || /^\d+$/.test(n)) continue;
      cont.set(n, (cont.get(n) || 0) + 1);
      if (!forma.has(n)) forma.set(n, limpo);
    }
  }
  return [...cont.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])
    .slice(0, limite).map(([n, c]) => [forma.get(n), c]);
}

/* ------------------------------------------------------------------ */
/* Notícias                                                            */
/* ------------------------------------------------------------------ */

const TERMOS_CONTEXTO = ['segundo turno', '2o turno', '2º turno', 'eleicao presidencial', 'corrida presidencial',
  'disputa presidencial', 'palacio do planalto', 'debate presidencial'];

async function coletarNoticias(fontesCfg, detector, anteriores) {
  const fontes = (fontesCfg.fontes || []).filter((f) => f.ativo !== false);
  const ok = []; const falha = [];
  const novos = [];

  await emLotes(fontes, 6, async (f) => {
    try {
      let xml;
      if (FEEDS_LOCAIS) {
        const arq = path.join(FEEDS_LOCAIS, norm(f.nome).replace(/[^a-z0-9]+/g, '-') + '.xml');
        xml = fs.readFileSync(arq, 'utf8');
      } else {
        xml = await baixar(f.url);
      }
      const itens = extrairItens(xml);
      let aproveitados = 0;
      for (const it of itens) {
        const textoNorm = norm(it.titulo + ' ' + it.resumo);
        const quem = mencoes(norm(it.titulo + ' ' + it.resumo), detector);
        const contexto = TERMOS_CONTEXTO.some((t) => textoNorm.includes(norm(t)));
        if (!quem.length && !contexto) continue;
        let veiculo = f.nome;
        let titulo = it.titulo;
        if (f.veiculoPorItem) {
          if (it.fonteItem) veiculo = it.fonteItem;
          // Google Notícias põe " - Veículo" no fim do título
          const m = titulo.match(/^(.*)\s[-–]\s([^-–]{2,60})$/);
          if (m) { titulo = m[1].trim(); if (!it.fonteItem) veiculo = m[2].trim(); }
        }
        const tom = classificarTom(norm(titulo));
        const data = dataValida(it.data) || AGORA;
        if (data.getTime() > AGORA.getTime() + 3600e3) continue; // data no futuro: descarta
        novos.push({
          id: norm(titulo).replace(/[^a-z0-9]+/g, '-').slice(0, 90),
          veiculo,
          fonteFeed: f.nome,
          titulo: cortar(titulo, 220),
          resumo: cortar(it.resumo && norm(it.resumo) !== norm(titulo) ? it.resumo : '', 200),
          link: it.link,
          dataPub: data.toISOString(),
          mencoes: quem,
          tom: tom.tom,
          coletadoEm: AGORA.toISOString(),
        });
        aproveitados++;
      }
      ok.push({ nome: f.nome, itens: itens.length, aproveitados });
    } catch (e) {
      falha.push({ nome: f.nome, erro: String(e.message || e).slice(0, 160) });
    }
  });

  // Junta com o histórico, remove duplicadas (mesmo título) e guarda 7 dias.
  const limite = AGORA.getTime() - 7 * 864e5;
  const mapa = new Map();
  for (const n of [...novos, ...(anteriores || [])]) {
    if (!n || !n.id || new Date(n.dataPub).getTime() < limite) continue;
    if (!mapa.has(n.id)) mapa.set(n.id, n);
  }
  const lista = [...mapa.values()].sort((a, b) => b.dataPub.localeCompare(a.dataPub)).slice(0, 400);
  return { lista, ok, falha };
}

function agregarMidia(noticias, candidatos, janelaHoras) {
  const desde = AGORA.getTime() - janelaHoras * 3600e3;
  const recentes = noticias.filter((n) => new Date(n.dataPub).getTime() >= desde);
  const mencoesC = {}; const tom = {};
  for (const c of candidatos) {
    const k = String(c.numero);
    mencoesC[k] = 0; tom[k] = { positivo: 0, neutro: 0, negativo: 0 };
  }
  for (const n of recentes) {
    for (const k of n.mencoes) {
      if (!(k in mencoesC)) continue;
      mencoesC[k]++;
      tom[k][n.tom]++;
    }
  }
  // Série diária (14 dias, fuso de Brasília) com o histórico disponível (até 7 dias).
  const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
  const serie = {};
  for (const n of noticias) {
    const dia = fmtDia.format(new Date(n.dataPub));
    serie[dia] = serie[dia] || Object.fromEntries(candidatos.map((c) => [String(c.numero), 0]));
    for (const k of n.mencoes) if (k in serie[dia]) serie[dia][k]++;
  }
  const veiculos = {};
  for (const n of recentes) veiculos[n.veiculo] = (veiculos[n.veiculo] || 0) + 1;
  return {
    janelaHoras,
    totalManchetes: recentes.length,
    mencoes: mencoesC,
    tom,
    termos: contarTermos(recentes.map((n) => n.titulo)),
    serieDiaria: Object.entries(serie).sort().map(([dia, v]) => ({ dia, ...v })),
    veiculos,
  };
}

/* ------------------------------------------------------------------ */
/* Pesquisas                                                           */
/* ------------------------------------------------------------------ */

const RE_REGISTRO = /^(BR|[A-Z]{2})-\d{5}\/\d{4}$/;

function validarPesquisas(cfg, candidatos) {
  const nums = candidatos.map((c) => String(c.numero));
  const validas = []; const descartadas = [];
  for (const p of (cfg.pesquisas || [])) {
    const reg = String(p.registroTSE || '').trim().toUpperCase();
    const motivo =
      !RE_REGISTRO.test(reg) ? 'sem registro TSE válido' :
      !p.instituto ? 'sem instituto' :
      !dataValida(p.campoFim) ? 'data de campo inválida' :
      !['totais', 'validos'].includes(p.tipo) ? "tipo deve ser 'totais' ou 'validos'" :
      nums.some((n) => typeof p[n] !== 'number') ? 'percentual de candidato ausente' : null;
    if (motivo) { descartadas.push({ instituto: p.instituto || '?', registroTSE: p.registroTSE || '', motivo }); continue; }
    validas.push({ ...p, registroTSE: reg });
  }
  validas.sort((a, b) => String(a.campoFim).localeCompare(String(b.campoFim)));
  return { validas, descartadas };
}

/* ------------------------------------------------------------------ */
/* TSE                                                                 */
/* ------------------------------------------------------------------ */

function pad6(c) { return String(c).padStart(6, '0'); }

/**
 * Monta o endereço de um arquivo de resultado a partir do modelo da CONFIGURAÇÃO.
 * Modelo de 2026 (EA20, "resultado unificado"):
 *   {base}/{ciclo}/{eleicao}/dados/{uf}/{uf}-c{cargo}-e{eleicao6}-u.json
 */
const MODELO_URL_PADRAO = '{base}/{ciclo}/{eleicao}/dados/{uf}/{uf}-c{cargo}-e{eleicao6}-u.json';
function urlTSE(tse, codigo, uf) {
  return (tse.modeloUrl || MODELO_URL_PADRAO)
    .replace(/\{base\}/g, tse.base.replace(/\/$/, ''))
    .replace(/\{ciclo\}/g, tse.ciclo)
    .replace(/\{eleicao6\}/g, pad6(codigo))
    .replace(/\{eleicao\}/g, String(codigo))
    .replace(/\{cargo\}/g, tse.cargo)
    .replace(/\{uf\}/g, uf);
}

/** Procura no arquivo de configuração público do TSE os códigos das eleições federais de 1º e 2º turno. */
async function descobrirCodigos(tse, anteriores) {
  const codigos = { turno1: tse.codigoTurno1 || anteriores?.turno1 || '', turno2: tse.codigoTurno2 || anteriores?.turno2 || '' };
  if (codigos.turno1 && codigos.turno2) return codigos;
  try {
    const cfg = await baixar(`${tse.base.replace(/\/$/, '')}/comum/config/ele-c.json`, { tipo: 'json' });
    const achados = [];
    (function andar(o) {
      if (Array.isArray(o)) return o.forEach(andar);
      if (o && typeof o === 'object') {
        if (o.cd && o.t && o.nm) achados.push(o);
        Object.values(o).forEach(andar);
      }
    })(cfg);
    const federais = achados.filter((e) => /federal/i.test(e.nm) && /2026/.test(e.nm + (e.dt || '')));
    const lista = federais.length ? federais : achados.filter((e) => /federal/i.test(e.nm));
    const t1 = lista.find((e) => String(e.t) === '1');
    const t2 = lista.find((e) => String(e.t) === '2');
    if (!codigos.turno1 && t1) codigos.turno1 = String(t1.cd);
    if (!codigos.turno2 && t2) codigos.turno2 = String(t2.cd);
  } catch (e) {
    log('Não consegui ler ele-c.json do TSE:', e.message);
  }
  return codigos;
}

/** Procura, em qualquer profundidade, o objeto que contém a lista de candidatos ('cand'). */
function acharComCandidatos(o) {
  if (!o || typeof o !== 'object') return null;
  if (Array.isArray(o)) { for (const x of o) { const r = acharComCandidatos(x); if (r) return r; } return null; }
  if (Array.isArray(o.cand) && o.cand.some((c) => c && c.n !== undefined)) return o;
  for (const v of Object.values(o)) { const r = acharComCandidatos(v); if (r) return r; }
  return null;
}

/** Junta os campos simples de um objeto (descendo em subobjetos, sem entrar em listas). */
function achatar(o, saida = {}) {
  for (const [k, v] of Object.entries(o || {})) {
    if (Array.isArray(v)) continue;
    if (v && typeof v === 'object') achatar(v, saida);
    else if (!(k in saida)) saida[k] = v;
  }
  return saida;
}

function pegarNum(f, chaves) {
  for (const k of chaves) { const n = num(f[k]); if (n !== null) return n; }
  return null;
}

/**
 * Lê um arquivo de resultado do TSE. Aceita o formato de 2026 (EA20, com a
 * abrangência dentro de uma lista) e o formato antigo (dados-simplificados),
 * procurando os campos pelos nomes usados nos dois modelos.
 */
function parseTSE(j) {
  const abr = acharComCandidatos(j);
  if (!abr) throw new Error('formato de arquivo do TSE não reconhecido (sem lista de candidatos)');
  const f = Object.assign(achatar(j), achatar(abr)); // campos da abrangência têm prioridade
  const cand = abr.cand.map((c) => ({
    numero: String(c.n), nome: c.nm || c.nmu || '', votos: num(c.vap) || 0, pct: num(c.pvap) || 0,
    eleito: /^s/i.test(String(c.e || '')),
  }));
  const eleitorado = pegarNum(f, ['te', 'e']);
  const comparecimento = pegarNum(f, ['tc', 'c']);
  const abstencao = pegarNum(f, ['ta', 'a']);
  const eleitoradoApurado = pegarNum(f, ['ea', 'tea']) || ((comparecimento || 0) + (abstencao || 0));
  return {
    pctSecoes: pegarNum(f, ['pst']) || 0,
    secoes: pegarNum(f, ['ts', 's']), secoesTotalizadas: pegarNum(f, ['st']),
    eleitorado, eleitoradoApurado, comparecimento, abstencao, pctAbstencao: pegarNum(f, ['pa', 'pta']),
    brancos: pegarNum(f, ['vb', 'tvb']), pctBrancos: pegarNum(f, ['pvb', 'ptvb']),
    nulos: pegarNum(f, ['tvn', 'vn', 'vnt']), pctNulos: pegarNum(f, ['ptvn', 'pvn', 'pvnt']),
    validos: pegarNum(f, ['vv', 'tvv']),
    candidatos: cand,
    horaTSE: [f.dg || f.dt, f.hg || f.ht].filter(Boolean).join(' '),
  };
}

/** Só declara "decidido" quando a diferença supera todos os eleitores ainda não apurados. */
function avaliarDecisao(r, numeros) {
  const [a, b] = numeros.map((n) => r.candidatos.find((c) => c.numero === n) || { votos: 0 });
  const diferenca = Math.abs(a.votos - b.votos);
  const lider = a.votos >= b.votos ? numeros[0] : numeros[1];
  const restante = Math.max(0, (r.eleitorado || 0) - (r.eleitoradoApurado || 0));
  const decidido = r.pctSecoes >= 100 ? diferenca > 0 : (r.eleitorado ? diferenca > restante : false);
  return { diferenca, lider, eleitoresRestantes: restante, decidido };
}

async function buscarResultadoUFs(tse, codigo, numeros) {
  const porUF = {};
  const falhas = [];
  await emLotes(UFS, 7, async (uf) => {
    try {
      const j = await baixar(urlTSE(tse, codigo, uf), { tipo: 'json', timeout: 12000 });
      const r = parseTSE(j);
      const v = {};
      let somaCand = 0;
      for (const c of r.candidatos) somaCand += c.votos;
      for (const n of numeros) {
        const c = r.candidatos.find((x) => x.numero === n) || { votos: 0, pct: 0 };
        v[n] = { votos: c.votos, pct: c.pct };
      }
      const outros = Math.max(0, somaCand - numeros.reduce((s, n) => s + v[n].votos, 0));
      porUF[uf.toUpperCase()] = {
        ...v,
        outros: { votos: outros, pct: r.validos ? +(100 * outros / r.validos).toFixed(2) : 0 },
        validos: r.validos, pctSecoes: r.pctSecoes, brancos: r.brancos, nulos: r.nulos,
        abstencao: r.abstencao, eleitorado: r.eleitorado, horaTSE: r.horaTSE,
      };
    } catch (e) {
      falhas.push(uf.toUpperCase() + ': ' + e.message);
    }
  });
  return { porUF, falhas };
}

async function coletarTSE(config, anterior) {
  const tse = config.tse;
  const numeros = config.candidatos.map((c) => String(c.numero));
  const saida = {
    codigos: anterior.tseCodigos || {},
    primeiroTurno: anterior.primeiroTurno && !anterior.primeiroTurno.exemplo ? anterior.primeiroTurno : null,
    apuracao: anterior.apuracao && !anterior.apuracao.exemplo ? anterior.apuracao : null,
    avisos: [],
  };
  if (SEM_REDE) { saida.avisos.push('TSE: rede desativada nesta execução.'); return saida; }

  saida.codigos = await descobrirCodigos(tse, anterior.tseCodigos);

  // 1º turno por UF (mapa pré-eleição). Atualiza até ficar completo.
  const t1 = saida.primeiroTurno;
  const completo = t1 && t1.uf && Object.keys(t1.uf).length >= 28 && Object.values(t1.uf).every((u) => u.pctSecoes >= 100);
  if (!completo && saida.codigos.turno1) {
    try {
      const br = parseTSE(await baixar(urlTSE(tse, saida.codigos.turno1, 'br'), { tipo: 'json' }));
      const { porUF, falhas } = await buscarResultadoUFs(tse, saida.codigos.turno1, numeros);
      const nacional = {};
      for (const n of numeros) {
        const c = br.candidatos.find((x) => x.numero === n) || { votos: 0, pct: 0 };
        nacional[n] = { votos: c.votos, pct: c.pct };
      }
      saida.primeiroTurno = {
        fonte: 'TSE', codigoEleicao: saida.codigos.turno1, horaTSE: br.horaTSE, pctSecoes: br.pctSecoes,
        nacional: { ...nacional, validos: br.validos, brancos: br.brancos, nulos: br.nulos, abstencao: br.abstencao, pctAbstencao: br.pctAbstencao },
        uf: { ...(t1 && t1.uf), ...porUF },
      };
      if (falhas.length) saida.avisos.push('TSE 1º turno — UFs sem resposta: ' + falhas.join('; '));
    } catch (e) {
      saida.avisos.push('TSE 1º turno indisponível: ' + e.message);
    }
  } else if (!saida.codigos.turno1) {
    saida.avisos.push('TSE: código da eleição do 1º turno não encontrado. Preencha tse.codigoTurno1 na CONFIGURAÇÃO do index.html.');
  }

  // Apuração do 2º turno (a partir de 10 min antes da divulgação, ou se forçado).
  const inicio = new Date(config.votacao.divulgacao).getTime() - 10 * 60e3;
  const forcar = process.env.FORCAR_APURACAO === '1';
  if ((AGORA.getTime() >= inicio || forcar) && saida.codigos.turno2) {
    try {
      const urlBr = urlTSE(tse, saida.codigos.turno2, 'br');
      const br = parseTSE(await baixar(urlBr, { tipo: 'json' }));
      const { porUF, falhas } = await buscarResultadoUFs(tse, saida.codigos.turno2, numeros);
      const votos = {};
      for (const n of numeros) {
        const c = br.candidatos.find((x) => x.numero === n) || { votos: 0, pct: 0 };
        votos[n] = { votos: c.votos, pct: c.pct };
      }
      saida.apuracao = {
        ativa: true, fonte: 'TSE (espelho do robô)', urlBr, codigoEleicao: saida.codigos.turno2,
        horaTSE: br.horaTSE, espelhadoEm: AGORA.toISOString(),
        pctSecoes: br.pctSecoes, eleitorado: br.eleitorado, comparecimento: br.comparecimento,
        abstencao: br.abstencao, pctAbstencao: br.pctAbstencao,
        brancos: br.brancos, pctBrancos: br.pctBrancos, nulos: br.nulos, pctNulos: br.pctNulos, validos: br.validos,
        votos, ...avaliarDecisao(br, numeros),
        uf: { ...(saida.apuracao && saida.apuracao.uf), ...porUF },
      };
      if (falhas.length) saida.avisos.push('TSE 2º turno — UFs sem resposta: ' + falhas.join('; '));
    } catch (e) {
      saida.avisos.push('TSE 2º turno indisponível: ' + e.message);
    }
  } else if (AGORA.getTime() >= inicio && !saida.codigos.turno2) {
    saida.avisos.push('TSE: código da eleição do 2º turno não encontrado. Preencha tse.codigoTurno2 na CONFIGURAÇÃO do index.html.');
  }
  if (saida.codigos.turno2) {
    saida.urlApuracaoBr = urlTSE(tse, saida.codigos.turno2, 'br');
  }
  return saida;
}

/* ------------------------------------------------------------------ */
/* Principal                                                           */
/* ------------------------------------------------------------------ */

async function principal() {
  const config = lerConfig();
  const candidatos = config.candidatos.map((c) => ({ numero: String(c.numero), nome: c.nome, partido: c.partido }));
  const anterior = lerJSON(ARQ.dados, {});
  const detector = prepararDetector(config.candidatos);

  const fontesCfg = lerJSON(ARQ.fontes, { fontes: [] });
  const pesqCfg = lerJSON(ARQ.pesquisas, { pesquisas: [] });
  const linhaCfg = lerJSON(ARQ.linha, { eventos: [] });
  const analise = lerJSON(ARQ.analise, null);

  // Notícias de exemplo não entram no histórico real.
  const historico = (anterior.meta && anterior.meta.exemplo) ? [] : (anterior.noticias || []);
  const noticias = await coletarNoticias(fontesCfg, detector, historico);
  log(`Notícias: ${noticias.lista.length} no histórico; fontes ok ${noticias.ok.length}, falhas ${noticias.falha.length}`);

  const { validas, descartadas } = validarPesquisas(pesqCfg, candidatos);
  log(`Pesquisas válidas: ${validas.length}; descartadas: ${descartadas.length}`);

  const tse = await coletarTSE(config, (anterior.meta && anterior.meta.exemplo) ? {} : anterior);
  tse.avisos.forEach((a) => log(a));

  const avisos = [...tse.avisos];
  if (descartadas.length) avisos.push(`${descartadas.length} pesquisa(s) fora da página: ` + descartadas.map((d) => `${d.instituto} (${d.motivo})`).join('; '));
  if (noticias.ok.length === 0 && noticias.lista.length === 0) avisos.push('Nenhum feed de notícias respondeu nesta execução.');

  const dados = {
    meta: {
      atualizadoEm: AGORA.toISOString(),
      exemplo: validas.some((p) => p.exemplo === true),
      versao: 1,
      geradoPor: 'coleta.js',
      fontesOk: noticias.ok,
      fontesFalha: noticias.falha,
      pesquisasDescartadas: descartadas,
      avisos,
    },
    candidatos,
    pesquisas: validas,
    noticias: noticias.lista,
    midia: agregarMidia(noticias.lista, candidatos, (config.midia && config.midia.janelaHoras) || 72),
    primeiroTurno: tse.primeiroTurno,
    apuracao: tse.apuracao || { ativa: false },
    tseCodigos: tse.codigos,
    urlApuracaoBr: tse.urlApuracaoBr || null,
    linhaTempo: (linhaCfg.eventos || []).slice().sort((a, b) => String(a.data).localeCompare(String(b.data))),
    analise,
  };

  // Se nada de novo veio e já havia dados reais, preserva notícias/TSE anteriores (já tratado acima).
  gravarJSON(ARQ.dados, dados);
  log('dados.json gravado em', dados.meta.atualizadoEm);
}

principal().catch((e) => {
  // Falha geral: não sobrescreve o dados.json existente. Sai com 0 para não travar o deploy da página.
  console.error('[coleta] ERRO GERAL — dados.json mantido como estava:', e && e.stack ? e.stack : e);
  process.exitCode = 0;
});
