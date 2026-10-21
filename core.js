// Baixador de Imagens: servidor local sem dependências (Node.js 22+).
// Serve a interface no navegador, escaneia páginas, resolve páginas de imagem e salva os arquivos.
'use strict';
const http = require('http');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 4517;
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(16).toString('hex');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IMAGE_EXTS = 'jpe?g|jfif|png|gif|webp|bmp|avif|tiff?|svg';
const VIDEO_EXTS = 'mp4|m4v|webm|mkv|avi|wmv|mpe?g|mov|flv|3gp|ogv';
// A extensão pode vir no fim, antes da query, ou dentro de um parâmetro (ex.: th?id=Foto_1920x1080.jpg&rf=…).
const IMAGE_EXT = new RegExp(`\\.(?:${IMAGE_EXTS})(?:$|[?#&])`, 'i');
const VIDEO_EXT = new RegExp(`\\.(?:${VIDEO_EXTS})(?:$|[?#&])`, 'i');
const MEDIA_EXT = new RegExp(`\\.(?:${IMAGE_EXTS}|${VIDEO_EXTS})(?:$|[?#&])`, 'i');
// Serviços de imagem sem extensão na URL: endpoint /th do Bing (Spotlight, papéis de parede, miniaturas de busca).
const BING_IMAGE = /^https?:\/\/(?:[\w-]+\.)*bing\.(?:com|net)\/th(?:\/id\/|\?(?:[^#]*&)?id=)(?:OHR|OBTQ|OIP|OIF|OVP|OVF|ODL|OPA|OSK)\./i;
const isImageUrl = (url) => IMAGE_EXT.test(url) || BING_IMAGE.test(url);
const MAX_FILE_BYTES = 4 * 1024 ** 3;
const MAX_PAGE_BYTES = 20 * 1024 * 1024;
const MAX_EXPANDED_URLS = 5000;
const IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_FOLDER = path.join(os.homedir(), 'Downloads', 'Imagens');
const EXT_BY_TYPE = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/bmp': '.bmp', 'image/avif': '.avif', 'image/tiff': '.tif', 'image/svg+xml': '.svg',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/quicktime': '.mov',
  'video/x-msvideo': '.avi', 'video/x-ms-wmv': '.wmv', 'video/mpeg': '.mpg', 'video/x-flv': '.flv',
};
const ACCEPT_HTML = 'text/html,application/xhtml+xml,*/*;q=0.8';
const ACCEPT_MEDIA = 'image/avif,image/webp,image/*,video/*,*/*;q=0.8';

// Credenciais HTTP (usuário/senha) informadas pelo usuário, por origem. Ficam só na memória.
const credentials = new Map();
const credentialPairs = new Map(); // mesma informação no formato que o navegador headless usa
const renderer = require('./render.js');

const fatal = (message, extra = {}) => Object.assign(new Error(message), { fatal: true }, extra);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- utilitários de HTML e URL ----------

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function resolveUrl(raw, base) {
  if (!raw) return null;
  const value = decodeEntities(String(raw).trim());
  if (!value || /^(data|javascript|blob|mailto):/i.test(value)) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function absoluteHttpUrl(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function parseAttributes(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([^\s"'<>\/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

const stripTags = (html) => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// Escolhe a maior variante de um srcset ("a.jpg 480w, b.jpg 1200w" ou "a.jpg 1x, b.jpg 2x").
function largestFromSrcset(srcset) {
  let best = null;
  let bestScore = -1;
  for (const part of srcset.split(/,\s+/)) {
    const [url, descriptor = '1x'] = part.trim().split(/\s+/);
    const value = parseFloat(descriptor) || 1;
    const score = descriptor.endsWith('w') ? value : value * 1000;
    if (url && score > bestScore) {
      best = url;
      bestScore = score;
    }
  }
  return best;
}

// Atributos que costumam trazer a versão grande (WordPress/Jetpack, plugins de zoom e lightbox).
const IMG_LARGE_ATTRS = ['data-full', 'data-full-url', 'data-fullsrc', 'data-orig-file', 'data-orig-src', 'data-original-src', 'data-large-file', 'data-large', 'data-hi-res', 'data-highres', 'data-zoom-image', 'data-zoom-src', 'data-zoom', 'data-big', 'data-image', 'data-original'];
// Atributos da imagem exibida (lazy-load e src).
const IMG_DISPLAY_ATTRS = ['data-src', 'data-lazy-src', 'data-lazy', 'data-url', 'src'];

// Todas as fontes de um <img>, da provável maior para a menor.
function imgSources(attrs, base) {
  const urls = [];
  const push = (raw) => {
    const url = resolveUrl(raw, base);
    if (url && !urls.includes(url)) urls.push(url);
  };
  for (const name of IMG_LARGE_ATTRS) if (attrs[name]) push(attrs[name]);
  for (const name of ['srcset', 'data-srcset', 'data-lazy-srcset']) if (attrs[name]) push(largestFromSrcset(attrs[name]));
  for (const [name, value] of Object.entries(attrs)) if (name.startsWith('data-') && !name.includes('srcset') && IMAGE_EXT.test(value)) push(value);
  for (const name of IMG_DISPLAY_ATTRS) if (attrs[name]) push(attrs[name]);
  return urls;
}

const imgSource = (attrs, base) => imgSources(attrs, base)[0] || null;

// Tamanho do original declarado na página (MediaWiki: data-file-width/height; WordPress: data-orig-size="w,h").
function declaredSize(attrs) {
  const pairs = [
    [attrs['data-file-width'], attrs['data-file-height']],
    (attrs['data-orig-size'] || '').split(','),
    [attrs['data-full-width'], attrs['data-full-height']],
    [attrs['data-original-width'], attrs['data-original-height']],
  ];
  for (const [w, h] of pairs) {
    const width = parseInt(w, 10);
    const height = parseInt(h, 10);
    if (width > 0 && height > 0) return { w: width, h: height };
  }
  return null;
}

// A imagem que o navegador mostra (a miniatura), não a versão grande.
function imgThumb(attrs, base) {
  for (const name of IMG_DISPLAY_ATTRS) {
    const url = attrs[name] && resolveUrl(attrs[name], base);
    if (url) return url;
  }
  return imgSource(attrs, base);
}

function pageTitle(html) {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]).slice(0, 120) : '';
}

function baseOf(html, pageUrl) {
  const baseTag = html.match(/<base\b[^>]*>/i);
  return (baseTag && resolveUrl(parseAttributes(baseTag[0]).href, pageUrl)) || pageUrl;
}

const looksLikeFileName = (text) => !!text && text.length <= 200 && MEDIA_EXT.test(text.trim()) && !/\s{2,}/.test(text);

const NEXT_TEXT = /^(next|next page|next ›|next »|próxima|próxima página|próximo|seguinte|siguiente|suivant|weiter|›|»|>|>>|→|older posts|mais antigas?)$/i;
const NEXT_ATTR = /(^|[\s_-])next([\s_-]|$)|nextpage|next_page|pagination-next|pager-next/i;

function isNextLink(attrs, text) {
  if (/(^|\s)next(\s|$)/i.test(attrs.rel || '')) return 2;
  if (NEXT_TEXT.test(text)) return 1;
  if (NEXT_ATTR.test(`${attrs.class || ''} ${attrs.id || ''} ${attrs['aria-label'] || ''} ${attrs.title || ''}`)) return 1;
  return 0;
}

// URLs absolutas de imagens e vídeos dentro de qualquer texto (scripts, JSON, HTML com escapes).
const MEDIA_URL_STOP = '[^\\s"\'<>\\\\(){}|^`]';
const MEDIA_URL_RE = new RegExp(`https?://${MEDIA_URL_STOP}+?\\.(?:jpe?g|png|gif|webp|avif|${VIDEO_EXTS})(?:\\?${MEDIA_URL_STOP}*)?(?=[\\s"'<>\\\\(){}|^\`,;]|$)`, 'gi');

// Endpoint de imagens do Bing, absoluto ou relativo ("/th?id=OBTQ.BT…&rs=2").
const BING_IMAGE_RE = /(?:https?:\/\/(?:[\w-]+\.)*bing\.(?:com|net))?\/th(?:\/id\/|\?id=)(?:OHR|OBTQ|OIP|OIF|OVP|OVF|ODL|OPA|OSK)\.[^\s"'<>\\(){}|^`,;]+/gi;

// Com `base`, URLs relativas do Bing também são resolvidas (só quando a página é do próprio Bing).
function findMediaUrls(text, base) {
  const clean = decodeEntities(text.replace(/\\u002[fF]/g, '/').replace(/\\u0026/gi, '&').replace(/\\\//g, '/'));
  const urls = new Set();
  for (const m of clean.matchAll(MEDIA_URL_RE)) {
    const url = absoluteHttpUrl(m[0]);
    if (url) urls.add(url);
  }
  const bingBase = base && /(^|\.)bing\.(com|net)$/i.test(new URL(base).hostname) ? base : 'https://www.bing.com/';
  for (const m of clean.matchAll(BING_IMAGE_RE)) {
    if (!m[0].startsWith('http') && bingBase !== base) continue;
    const url = resolveUrl(m[0], bingBase);
    if (url) urls.add(url);
  }
  return [...urls];
}

// ---------- extração de uma página ----------

// Tipos: "linked" = link direto para um arquivo de imagem (em galerias, o tamanho cheio),
// "embedded" = imagem exibida na página, "script" = URL encontrada em scripts/JSON,
// "meta" = og:image / twitter:image, "video" = arquivo de vídeo.
const KIND_RANK = { linked: 5, video: 5, hosted: 5, embedded: 3, meta: 2, script: 1 };

// Remove scripts, estilos e comentários antes de ler as tags: strings de JavaScript como
// '<a href="/foto' + n + '.jpg">' não são links de verdade.
const stripCode = (html) => html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');

function extractPage(source, pageUrl, { scripts = true } = {}) {
  const html = stripCode(source);
  const base = baseOf(html, pageUrl);
  const pageHost = new URL(pageUrl).host;
  const found = new Map();
  const secondary = new Map();
  const next = [];

  const add = (raw, kind, extra = {}) => {
    const url = resolveUrl(raw, base);
    if (!url) return;
    const prev = found.get(url);
    if (prev && KIND_RANK[prev.kind] >= KIND_RANK[kind]) {
      for (const [k, v] of Object.entries(extra)) if (v && !prev[k]) prev[k] = v;
      return;
    }
    found.set(url, { ...prev, url, kind, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v)) });
  };

  // Links: arquivos de imagem/vídeo, páginas de imagem (link em volta de miniatura) e paginação.
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = parseAttributes(`<a ${m[1]}>`);
    const href = resolveUrl(attrs.href, base);
    if (!href) continue;
    const inner = m[2];
    const imgTag = inner.match(/<img\b[^>]*>/i);
    const imgAttrs = imgTag ? parseAttributes(imgTag[0]) : null;
    const thumb = imgAttrs ? imgThumb(imgAttrs, base) : null;
    const text = stripTags(inner);
    const nameHint = [attrs.download, attrs.title, imgAttrs?.title, imgAttrs?.alt, text].find(looksLikeFileName);
    if (VIDEO_EXT.test(href)) add(href, 'video', { thumb, nameHint });
    else if (isImageUrl(href)) {
      // Fontes grandes declaradas na própria miniatura (data-full etc.) concorrem com o link.
      const alternates = imgAttrs ? imgSources(imgAttrs, base).filter((u) => u !== thumb && u !== href) : [];
      add(href, 'linked', { thumb, nameHint, alternates: alternates.length ? alternates : null, declared: imgAttrs ? declaredSize(imgAttrs) : null });
    }
    else {
      const nextScore = new URL(href).host === pageHost && href !== pageUrl ? isNextLink(attrs, text) : 0;
      if (nextScore) next.push({ url: href, score: nextScore });
      else if (thumb && href !== pageUrl && !secondary.has(href)) secondary.set(href, { url: href, thumb });
    }
  }

  // Cada <img> e cada <picture> vira um único item; as demais fontes viram alternativas a medir.
  const addImage = (sources, attrs) => {
    if (!sources.length) return;
    const thumb = attrs ? imgThumb(attrs, base) : null;
    const nameHint = attrs ? [attrs.title, attrs.alt].find(looksLikeFileName) : null;
    add(sources[0], 'embedded', {
      nameHint,
      thumb: thumb !== sources[0] ? thumb : null,
      alternates: sources.length > 1 ? sources.slice(1) : null,
      declared: attrs ? declaredSize(attrs) : null,
    });
  };
  for (const m of html.matchAll(/<picture\b[^>]*>([\s\S]*?)<\/picture>/gi)) {
    const sources = [];
    let imgAttrs = null;
    for (const t of m[1].matchAll(/<(source|img)\b[^>]*>/gi)) {
      const attrs = parseAttributes(t[0]);
      if (t[1].toLowerCase() === 'img') {
        imgAttrs = attrs;
        sources.push(...imgSources(attrs, base));
      } else if (!(attrs.type || '').startsWith('video/')) {
        for (const name of ['srcset', 'data-srcset']) if (attrs[name]) sources.push(resolveUrl(largestFromSrcset(attrs[name]), base));
      }
    }
    addImage([...new Set(sources.filter(Boolean))], imgAttrs);
  }

  const outsidePictures = html.replace(/<picture\b[\s\S]*?<\/picture>/gi, '');
  for (const m of outsidePictures.matchAll(/<(img|source|video|meta|link)\b[^>]*>/gi)) {
    const tag = m[1].toLowerCase();
    const attrs = parseAttributes(m[0]);
    if (tag === 'img') {
      addImage(imgSources(attrs, base), attrs);
    } else if (tag === 'source') {
      for (const name of ['srcset', 'data-srcset']) if (attrs[name]) add(largestFromSrcset(attrs[name]), 'embedded');
      if (attrs.src) {
        if ((attrs.type || '').startsWith('video/') || VIDEO_EXT.test(attrs.src)) add(attrs.src, 'video');
        else if (isImageUrl(resolveUrl(attrs.src, base) || '')) add(attrs.src, 'embedded');
      }
    } else if (tag === 'video') {
      if (attrs.src) add(attrs.src, 'video', { thumb: resolveUrl(attrs.poster, base) });
      if (attrs.poster) add(attrs.poster, 'embedded');
    } else if (tag === 'meta') {
      const prop = attrs.property || attrs.name || '';
      if (/^(og:image|twitter:image)(:src|:url|:secure_url)?$/i.test(prop) && attrs.content) add(attrs.content, 'meta');
      if (/^og:video(:url|:secure_url)?$/i.test(prop) && attrs.content && VIDEO_EXT.test(attrs.content)) add(attrs.content, 'video');
    } else if (/(^|\s)image_src(\s|$)/i.test(attrs.rel || '')) {
      add(attrs.href, 'meta');
    } else if (/(^|\s)next(\s|$)/i.test(attrs.rel || '')) {
      const href = resolveUrl(attrs.href, base);
      if (href) next.push({ url: href, score: 3 });
    }
  }

  // URLs dentro de scripts/JSON: galerias montadas por JavaScript, rolagem infinita, resultados de busca.
  if (scripts) {
    for (const url of findMediaUrls(source, base)) if (!found.has(url)) add(url, VIDEO_EXT.test(url) ? 'video' : 'script');
  }

  for (const url of found.keys()) secondary.delete(url);
  const nextUrls = [...new Map(next.sort((a, b) => b.score - a.score).map((n) => [n.url, n])).keys()].slice(0, 3);
  for (const url of nextUrls) secondary.delete(url);
  return { title: pageTitle(html), images: [...found.values()], secondary: [...secondary.values()], next: nextUrls };
}

// Redirecionadores que mostram propaganda antes da imagem: meta refresh ou location em JavaScript.
function findRedirect(html, base) {
  const meta = html.match(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/i);
  if (meta) {
    const target = (parseAttributes(meta[0]).content || '').match(/url\s*=\s*['"]?([^'";]+)/i);
    if (target) return resolveUrl(target[1], base);
  }
  const js = html.match(/(?:window\.|document\.|top\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']|location\.(?:replace|assign)\(\s*["']([^"']+)["']/i);
  return js ? resolveUrl(js[1] || js[2], base) : null;
}

// ---------- pontuação heurística da imagem principal de uma página de imagem ----------

const NEGATIVE_HINT = /(logo|icon|sprite|avatar|banner|(^|[\W_])ads?([\W_]|$)|advert|button|btn|pixel|spacer|blank|badge|emoji|smil|loading|placeholder|header|footer|social|share|facebook|twitter|rating|star|thumb)/i;
const POSITIVE_HINT = /(main|full|large|big|orig|hires|hi-res|zoom|photo|picture|image|img|showimage|imageview|viewer)/i;

function stemOf(url) {
  try {
    return path.posix.parse(new URL(url).pathname).name.toLowerCase()
      .replace(/^(th_|thumb_|thumbs_|tn_|t_|sm_|small_)/, '')
      .replace(/([_-](t|th|thumb|tn|small|sm|s|m|medium)|[_-]\d+x\d+)$/, '');
  } catch {
    return '';
  }
}

function rankCandidates(source, pageUrl, thumb) {
  const html = stripCode(source);
  const base = baseOf(html, pageUrl);
  const thumbStem = thumb ? stemOf(thumb) : '';
  const ogTag = html.match(/<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*>/i);
  const ogImage = ogTag ? resolveUrl(parseAttributes(ogTag[0]).content, base) : null;
  const scores = new Map();

  const evaluate = (url, attrs) => {
    let score = 0;
    const hints = `${attrs.id || ''} ${attrs.class || ''} ${attrs.alt || ''} ${attrs.name || ''}`;
    if (POSITIVE_HINT.test(hints)) score += 25;
    if (NEGATIVE_HINT.test(new URL(url).pathname) || NEGATIVE_HINT.test(hints)) score -= 40;
    const w = parseInt(attrs.width, 10) || 0;
    const h = parseInt(attrs.height, 10) || 0;
    if (w && h) score += w * h >= 250_000 ? 30 : w * h >= 60_000 ? 15 : w * h < 10_000 ? -30 : 0;
    if (MEDIA_EXT.test(url)) score += 10;
    if (thumb && url === thumb) score -= 25;
    else if (thumbStem.length >= 4 && stemOf(url) === thumbStem) score += 30;
    if (url === ogImage) score += 25;
    return score;
  };
  const bump = (url, points, extra = {}) => {
    if (!url) return;
    const entry = scores.get(url) || { url, kind: VIDEO_EXT.test(url) ? 'video' : 'hosted', score: 0 };
    entry.score += points;
    Object.assign(entry, extra);
    scores.set(url, entry);
  };

  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const attrs = parseAttributes(m[0]);
    const [src, ...alternates] = imgSources(attrs, base);
    if (src) bump(src, 10 + evaluate(src, attrs), { nameHint: [attrs.title, attrs.alt].find(looksLikeFileName), alternates });
  }
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = parseAttributes(`<a ${m[1]}>`);
    const href = resolveUrl(attrs.href, base);
    if (href && (MEDIA_EXT.test(href) || BING_IMAGE.test(href))) {
      const text = stripTags(m[2]);
      bump(href, 30 + evaluate(href, attrs) + (/download|original|full|tamanho/i.test(text) ? 15 : 0), { nameHint: [attrs.download, text].find(looksLikeFileName) });
    }
  }
  for (const m of html.matchAll(/<(?:video|source)\b[^>]*>/gi)) {
    const attrs = parseAttributes(m[0]);
    const src = resolveUrl(attrs.src, base);
    if (src && (VIDEO_EXT.test(src) || (attrs.type || '').startsWith('video/'))) bump(src, 60, { kind: 'video' });
  }
  if (ogImage && !scores.has(ogImage)) bump(ogImage, 15);
  return [...scores.values()].sort((a, b) => b.score - a.score);
}

// ---------- rede ----------

function fetchFrom(url, { referer, accept, timeoutMs = 30_000, signal, range }) {
  const headers = { 'user-agent': USER_AGENT, accept };
  if (referer) headers.referer = referer;
  const auth = credentials.get(new URL(url).origin);
  if (auth) headers.authorization = auth;
  if (range) headers.range = `bytes=${range}`;
  return fetch(url, { headers, redirect: 'follow', signal: signal || AbortSignal.timeout(timeoutMs) });
}

async function readLimited(body, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > limit) throw new Error('página grande demais');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Só um 401 com desafio Basic/Digest é pedido de senha; 401 sem desafio é bloqueio anti-robô.
const isLoginChallenge = (status, authenticate) => status === 401 && /\b(basic|digest)\b/i.test(authenticate || '');

function authError(res) {
  const realm = ((res.headers.get('www-authenticate') || '').match(/realm="?([^",]*)/i) || [])[1] || '';
  return fatal('o site pede usuário e senha', { auth: { origin: new URL(res.url).origin, realm } });
}

async function fetchPage(url, referer) {
  const res = await fetchFrom(url, { referer, accept: ACCEPT_HTML });
  if (isLoginChallenge(res.status, res.headers.get('www-authenticate'))) {
    await res.body?.cancel();
    throw authError(res);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type.startsWith('image/') || type.startsWith('video/')) {
    await res.body?.cancel();
    return { finalUrl: res.url, mediaType: type };
  }
  return { finalUrl: res.url, html: (await readLimited(res.body, MAX_PAGE_BYTES)).toString('utf8') };
}

// ---------- navegador headless (galerias em JavaScript) ----------

const SPA_MARKERS = /<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>|__NEXT_DATA__|__NUXT__|ng-version=|data-reactroot|<noscript>[^<]*(enable|ative|habilite)[^<]*javascript/i;
const LAZY_MARKERS = /infinite[-_ ]?scroll|load[-_ ]?more|loadmore|carregar mais|IntersectionObserver|masonry/i;

// Decide se vale abrir no navegador: página quase vazia, app em JavaScript ou rolagem infinita.
// Ícones, SVGs, logos e pixels de rastreamento não contam como fotos encontradas.
const NOT_A_PHOTO = /\.svg(?:$|[?#&])|(^|[\W_])(logo|icon|favicon|sprite|avatar|emoji|badge|spacer|pixel|blank|loader|spinner)([\W_]|$)|\/(action|collect|pixel|beacon|track)(\/|\?|$)/i;

function needsRendering(result, html) {
  const photos = result.images.filter((i) => i.kind !== 'meta' && !NOT_A_PHOTO.test(i.url));
  const found = photos.length + result.secondary.length;
  if (found < 5) return true;
  if (SPA_MARKERS.test(html) && found < 30) return true;
  return LAZY_MARKERS.test(html);
}

// Une dois resultados da mesma página (estático + renderizado), sem duplicar e mantendo a origem mais forte.
function mergeScans(a, b) {
  const images = new Map(a.images.map((i) => [i.url, i]));
  for (const img of b.images) {
    const prev = images.get(img.url);
    if (!prev || KIND_RANK[img.kind] > KIND_RANK[prev.kind]) images.set(img.url, { ...prev, ...img });
  }
  const secondary = new Map([...a.secondary, ...b.secondary].map((s) => [s.url, s]));
  for (const url of images.keys()) secondary.delete(url);
  return {
    ...a,
    title: a.title || b.title,
    images: [...images.values()],
    secondary: [...secondary.values()],
    next: [...new Set([...a.next, ...b.next])].slice(0, 3),
  };
}

const loginFor = (origin) => credentialPairs.get(origin);

// Mesma imagem em tamanhos diferentes (?w=600, ?w=1200, foto-300x200.jpg…) tem a mesma chave.
function canonicalKey(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (RESIZE_PARAMS.test(key)) u.searchParams.delete(key);
    u.pathname = u.pathname.replace(/-\d{2,4}x\d{2,4}(?=\.\w+$)/, '');
    return u.href;
  } catch {
    return url;
  }
}

// Maior dimensão sugerida pela URL; sem nenhuma pista, provavelmente é o original.
function sizeHint(url) {
  try {
    const u = new URL(url);
    const numbers = [...u.searchParams].filter(([k]) => RESIZE_PARAMS.test(k)).map(([, v]) => parseInt(v, 10)).filter((n) => n > 0);
    const wh = u.pathname.match(/-(\d{2,4})x(\d{2,4})\.\w+$/);
    if (wh) numbers.push(Number(wh[1]), Number(wh[2]));
    return numbers.length ? Math.max(...numbers) : Infinity;
  } catch {
    return 0;
  }
}

// Junta variantes de tamanho num item só; guarda as 4 mais promissoras como alternativas a medir.
function collapseVariants(images) {
  const groups = new Map();
  for (const img of images) {
    const key = img.kind === 'video' ? img.url : canonicalKey(img.url);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { ...img });
      continue;
    }
    const [keep, drop] = KIND_RANK[img.kind] > KIND_RANK[current.kind] ? [{ ...img }, current] : [current, img];
    for (const field of ['thumb', 'nameHint', 'declared']) if (!keep[field] && drop[field]) keep[field] = drop[field];
    keep.alternates = [...new Set([...(keep.alternates || []), drop.url, ...(drop.alternates || [])])].filter((u) => u !== keep.url);
    groups.set(key, keep);
  }
  return [...groups.values()].map((img) => {
    if (!img.alternates?.length) return img;
    const alternates = [...img.alternates].sort((a, b) => sizeHint(b) - sizeHint(a)).slice(0, 4);
    return { ...img, alternates };
  });
}

async function renderAndExtract(url, options, referer) {
  const r = await renderer.renderPage(url, {
    referer,
    userAgent: USER_AGENT,
    credentials: loginFor,
    scroll: options.scroll !== false,
    maxScrolls: Math.min(100, Math.max(0, Number(options.maxScrolls) || 15)),
    findUrls: findMediaUrls,
  });
  if (isLoginChallenge(r.status, r.authenticate)) {
    const realm = ((r.authenticate || '').match(/realm="?([^",]*)/i) || [])[1] || '';
    throw fatal('o site pede usuário e senha', { auth: { origin: new URL(url).origin, realm } });
  }
  if (r.status >= 400) throw new Error(`HTTP ${r.status} (navegador)`);
  const result = { finalUrl: r.finalUrl, ...extractPage(r.html, r.finalUrl, options) };
  // Imagens e vídeos que a página carregou pela rede ou recebeu em JSON (rolagem infinita, APIs de galeria).
  const known = new Set(result.images.map((i) => i.url));
  for (const mediaUrl of [...r.media, ...r.fromData]) {
    if (known.has(mediaUrl) || mediaUrl === r.finalUrl) continue;
    known.add(mediaUrl);
    result.images.push({ url: mediaUrl, kind: VIDEO_EXT.test(mediaUrl) ? 'video' : 'script' });
  }
  return { ...result, html: r.html, render: { scrolls: r.scrolls, clicks: r.clicks, browser: r.channel } };
}

// render: "auto" (só quando a leitura simples parecer insuficiente), "always" ou "never".
async function scanPage(url, options) {
  const mode = options.render || 'auto';
  let simple = null;
  let simpleError = null;
  if (mode !== 'always') {
    try {
      const page = await fetchPage(url);
      if (page.mediaType) {
        return { finalUrl: page.finalUrl, title: '', images: [{ url: page.finalUrl, kind: page.mediaType.startsWith('video/') ? 'video' : 'linked' }], secondary: [], next: [], rendered: false };
      }
      simple = { finalUrl: page.finalUrl, ...extractPage(page.html, page.finalUrl, options) };
      if (mode === 'never' || !renderer.isInstalled() || !needsRendering(simple, page.html)) {
        return { ...simple, images: collapseVariants(simple.images), rendered: false };
      }
    } catch (err) {
      // Pedidos de senha seguem para a interface; outros bloqueios (ex.: 403 anti-robô) ainda podem abrir no navegador.
      if (err.auth || mode === 'never' || !renderer.isInstalled()) throw err;
      simpleError = err;
    }
  }
  try {
    const { html, ...rendered } = await renderAndExtract(url, options);
    const merged = simple ? mergeScans(simple, rendered) : rendered;
    return { ...merged, images: collapseVariants(merged.images), finalUrl: rendered.finalUrl, render: rendered.render, rendered: true };
  } catch (err) {
    if (simple) return { ...simple, images: collapseVariants(simple.images), rendered: false, renderError: err.message };
    throw err.auth || !simpleError ? err : new Error(`${simpleError.message}; no navegador: ${err.message}`);
  }
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- tamanho real das imagens (lido do cabeçalho do arquivo) ----------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NEED_MORE = Symbol('need-more');

// Devolve { type, w, h }, NEED_MORE se faltam bytes, ou null se o formato não é reconhecido.
function imageSize(buf) {
  if (buf.length < 12) return NEED_MORE;
  if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return buf.length < 24 ? NEED_MORE : { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.toString('latin1', 0, 4) === 'GIF8') return { type: 'gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf[0] === 0x42 && buf[1] === 0x4d) return buf.length < 26 ? NEED_MORE : { type: 'bmp', w: Math.abs(buf.readInt32LE(18)), h: Math.abs(buf.readInt32LE(22)) };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    if (buf.length < 30) return NEED_MORE;
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return { type: 'webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { type: 'webp', w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { type: 'webp', w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    // Percorre os segmentos até o SOF (pula EXIF, ICC e miniaturas embutidas pelo tamanho declarado).
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpeg', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return NEED_MORE;
  }
  if (buf.toString('latin1', 4, 8) === 'ftyp' && /avif|avis|heic|heix|mif1/.test(buf.toString('latin1', 8, 32))) {
    // AVIF/HEIF: maior caixa "ispe" (largura e altura da imagem).
    let best = null;
    for (let i = buf.indexOf('ispe'); i >= 0 && i + 16 <= buf.length; i = buf.indexOf('ispe', i + 4)) {
      const w = buf.readUInt32BE(i + 8);
      const h = buf.readUInt32BE(i + 12);
      if (!best || w * h > best.w * best.h) best = { type: 'avif', w, h };
    }
    return best || NEED_MORE;
  }
  return null;
}

const PROBE_BYTES = 512 * 1024;
const PROBE_PER_HOST = 4;
const DOWNLOAD_PER_HOST = 6;
const probeCache = new Map();
const hostSlots = new Map();

// Limita conexões simultâneas por site (evita "429 Too Many Requests" em CDNs como a da Wikimedia).
// Devolve a função que libera a vaga.
async function acquireHostSlot(url, pool, limit) {
  const key = `${pool} ${new URL(url).host}`;
  let slot = hostSlots.get(key);
  if (!slot) hostSlots.set(key, (slot = { active: 0, waiting: [] }));
  if (slot.active < limit) slot.active++;
  else await new Promise((resolve) => slot.waiting.push(resolve)); // recebe a vaga de quem terminou
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = slot.waiting.shift();
    if (next) next();
    else slot.active--;
  };
}

async function withHostSlot(url, fn) {
  const release = await acquireHostSlot(url, 'probe', PROBE_PER_HOST);
  try {
    return await fn();
  } finally {
    release();
  }
}

async function probeOnce(url, referer) {
  const res = await fetchFrom(url, { referer, accept: ACCEPT_MEDIA, timeoutMs: 20_000, range: `0-${PROBE_BYTES - 1}` });
  if (res.status === 429 || res.status === 503) {
    await res.body?.cancel();
    return { ok: false, transient: true, reason: `HTTP ${res.status}`, retryAfter: Number(res.headers.get('retry-after')) || 0 };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { ok: false, reason: `HTTP ${res.status}` };
  }
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type && !/^(image\/|application\/octet-stream|binary\/)/.test(type)) {
    await res.body?.cancel();
    return { ok: false, reason: type };
  }
  const rangeTotal = Number(((res.headers.get('content-range') || '').match(/\/(\d+)$/) || [])[1]) || 0;
  const bytes = res.headers.get('content-encoding') ? 0 : rangeTotal || (res.status === 200 ? Number(res.headers.get('content-length')) || 0 : 0);
  let buf = Buffer.alloc(0);
  let size = NEED_MORE;
  for await (const chunk of res.body) {
    buf = Buffer.concat([buf, chunk]);
    size = imageSize(buf);
    if (size !== NEED_MORE || buf.length >= PROBE_BYTES) break;
  }
  if (size && size !== NEED_MORE && size.w && size.h) return { ok: true, w: size.w, h: size.h, bytes, format: size.type };
  if (type === 'image/svg+xml') return { ok: true, w: 0, h: 0, bytes, format: 'svg' };
  return { ok: false, reason: 'formato não reconhecido' };
}

// Baixa só o começo do arquivo (Range) para descobrir largura, altura e tamanho em bytes.
function probeImage(url, referer) {
  if (probeCache.has(url)) return probeCache.get(url);
  const pending = (async () => {
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await withHostSlot(url, () => probeOnce(url, referer));
      } catch (err) {
        result = { ok: false, transient: true, reason: err.name === 'TimeoutError' ? 'tempo esgotado' : err.message };
      }
      if (!result.transient || attempt === 2) break;
      await sleep(Math.min(4, result.retryAfter || attempt + 1) * 1000);
    }
    // Falhas temporárias não ficam em cache: uma nova medição pode dar certo.
    if (result.transient) probeCache.delete(url);
    return result;
  })();
  probeCache.set(url, pending);
  if (probeCache.size > 5000) probeCache.delete(probeCache.keys().next().value);
  return pending;
}

// ---------- variantes maiores de uma URL (padrões de CDNs, CMSs e galerias) ----------

const RESIZE_PARAMS = /^(w|h|width|height|size|sz|resize|fit|crop|quality|q|dpr|maxwidth|maxheight|max_width|max_height|max-w|max-h|imwidth|imheight|scale|tw|th|wid|hei|res|resolution|fm|auto|downsize)$/i;
const SMALL_SEGMENTS = ['thumbs', 'thumb', 'thumbnails', 'thumbnail', 'small', 'medium', 'preview', 'previews', 'resized', 'th', 'tn', 'mini', 't'];

// Com knownOnly, devolve só as regras específicas de sites conhecidos (confiáveis o bastante para usar mesmo sem medir).
function upgradeCandidates(raw, { knownOnly = false } = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return [];
  }
  const out = [];
  const add = (candidate) => {
    const url = absoluteHttpUrl(candidate);
    if (url && url !== raw && !out.includes(url)) out.push(url);
  };
  const host = u.hostname;
  const p = u.pathname;
  const withPath = (pathname) => Object.assign(new URL(u), { pathname }).href;
  const withQuery = (edit) => {
    const c = new URL(u);
    edit(c.searchParams);
    return c.href;
  };
  const ext = '(\\.(?:jpe?g|jfif|png|gif|webp|avif|bmp))$';

  // Serviços conhecidos.
  if (host === 'pbs.twimg.com') {
    add(withQuery((q) => q.set('name', 'orig')));
    add(raw.replace(/:(small|medium|large|thumb)$/, ':orig'));
  }
  if (/(googleusercontent\.com|ggpht\.com|bp\.blogspot\.com)$/.test(host)) {
    add(raw.replace(/=[swh]\d+[^/?#]*$/, '=s0'));
    add(withPath(p.replace(/\/[swh]\d+(-[a-z0-9-]+)?\//i, '/s0/')));
  }
  if (/(^|\.)wikimedia\.org$/.test(host)) {
    // Miniaturas (upload. ou thumb.wikimedia.org/.../thumb/a/ab/Arquivo.jpg/330px-Arquivo.jpg) → original em upload.
    const m = p.match(/^(.*)\/thumb(\/[^/]+\/[^/]+\/[^/]+)\/[^/]+$/);
    if (m) add(`https://upload.wikimedia.org${m[1]}${m[2]}`);
  }
  if (/(^|\.)tumblr\.com$/.test(host)) add(withPath(p.replace(/_(75sq|100|250|400|500|540|640)(\.\w+)$/, '_1280$2')));
  if (host === 'i.imgur.com') add(withPath(p.replace(/^\/(\w{5,7})[sbtmlh](\.\w+)$/, '/$1$2')));
  if (host === 'i.pinimg.com') add(withPath(p.replace(/^\/\d+x\d*\//, '/originals/')));
  if (BING_IMAGE.test(raw) && u.searchParams.get('id')) {
    // Bing /th: sem parâmetros de redução (rs, c, w, h, qlt…) vem o arquivo original; papéis de parede OHR têm versão UHD.
    const id = u.searchParams.get('id');
    const bing = (value) => `${u.origin}/th?id=${encodeURIComponent(value).replace(/%2E/gi, '.')}`;
    if (/^OHR\./i.test(id)) add(bing(id.replace(/_(?:\d{3,4}x\d{3,4}|tmb|UHD)(\.\w+)$/i, '_UHD$1')));
    add(bing(id));
  }
  if (/staticflickr\.com$/.test(host)) add(withPath(p.replace(/_[sqtmnzc](\.\w+)$/, '_b$1').replace(/(\/\d+_[0-9a-f]+)(\.\w+)$/, '$1_b$2')));
  if (host === 'preview.redd.it' || host === 'external-preview.redd.it') add(Object.assign(new URL(u), { hostname: 'i.redd.it', search: '' }).href);
  if (host === 'i.ytimg.com') add(withPath(p.replace(/\/(default|mqdefault|hqdefault|sddefault)\.jpg$/, '/maxresdefault.jpg')));
  if (/(^|\.)cloudinary\.com$/.test(host)) add(withPath(p.replace(/\/upload\/(?:[a-z]{1,3}_[^/]*\/)+/, '/upload/')));
  if (/(media-amazon|images-amazon|ssl-images-amazon)\.com$/.test(host)) add(withPath(p.replace(/\._[^/]*_(\.\w+)$/, '$1')));
  if (host === 'cdn.shopify.com' || p.includes('/cdn/shop/')) {
    add(withPath(p.replace(/_(\d+x\d*|\d*x\d+|pico|icon|thumb|small|compact|medium|large|grande)(@\dx)?(\.\w+)$/, '$3')));
  }

  // Quando um site conhecido casou, os palpites genéricos só gerariam requisições inúteis.
  if (out.length || knownOnly) return out;

  // Padrões genéricos.
  add(withPath(p.replace(new RegExp(`-\\d{2,4}x\\d{2,4}${ext}`, 'i'), '$1'))); // WordPress: foto-300x200.jpg
  add(withPath(p.replace(new RegExp(`-scaled${ext}`, 'i'), '$1'))); // WordPress: foto-scaled.jpg
  add(withPath(p.replace(new RegExp(`[_.-](thumb|thumbnail|small|sm|tn|th|t|s|m|med|medium|preview|mini|lowres|low|lq)${ext}`, 'i'), '$2')));
  add(withPath(p.replace(/\/(th_|thumb_|thumbs_|tn_|t_|sm_|small_|thumbnail_)([^/]+)$/i, '/$2')));
  add(withPath(p.replace(/\/\d{2,4}x\d{2,4}\//, '/')));
  for (const segment of SMALL_SEGMENTS) {
    const re = new RegExp(`/${segment}/`, 'i');
    if (!re.test(p)) continue;
    for (const replacement of ['/', '/full/', '/large/', '/original/', '/images/', '/big/']) add(withPath(p.replace(re, replacement)));
  }
  if ([...u.searchParams.keys()].some((k) => RESIZE_PARAMS.test(k))) {
    add(withQuery((q) => { for (const k of [...q.keys()]) if (RESIZE_PARAMS.test(k)) q.delete(k); }));
  }
  return out.slice(0, 16);
}

// Mede a URL, as fontes alternativas e as variantes maiores; fica com a de mais pixels (depois, mais bytes).
// upgrade: false só mede a própria URL (sem procurar versões maiores).
async function bestVersion({ url, referer, alternates = [], thumb, declared, depth = 0, upgrade = true }) {
  const extras = upgrade ? alternates.map(absoluteHttpUrl).filter(Boolean) : [];
  const sources = [url, ...extras];
  const trusted = new Set(upgrade ? sources.flatMap((s) => upgradeCandidates(s, { knownOnly: true })) : []);
  const candidates = upgrade ? [...new Set([...sources, ...sources.flatMap((s) => upgradeCandidates(s))])].slice(0, 24) : [url];
  const results = await mapLimited(candidates, 4, async (candidate) => ({ url: candidate, ...(await probeImage(candidate, referer)) }));
  const valid = results.filter((r) => r.ok);
  const original = results[0];

  // Regra de um site conhecido (ex.: original da Wikimedia) que não pôde ser medida porque o site limitou as
  // requisições: confia na regra, que aponta para o arquivo original, e usa o tamanho declarado na página.
  const throttled = results.find((r) => !r.ok && r.transient && trusted.has(r.url));
  if (throttled && !valid.some((r) => trusted.has(r.url))) {
    const biggestMeasured = valid.reduce((max, r) => Math.max(max, r.w * r.h), 0);
    if (!declared || declared.w * declared.h > biggestMeasured) {
      return {
        url: throttled.url,
        w: declared?.w || 0,
        h: declared?.h || 0,
        bytes: 0,
        measured: true,
        unverified: true,
        upgraded: throttled.url !== url,
        original: original.ok ? { w: original.w, h: original.h } : null,
        tried: candidates.length,
      };
    }
  }

  if (!valid.length) {
    // Link com cara de arquivo que abre uma página (ex.: /wiki/File:Foto.jpg): trata como página de imagem.
    if (depth === 0 && /^text\/html/.test(original.reason || '')) {
      try {
        const page = await resolveSecondary(url, referer, thumb);
        if (page.best && page.best.kind !== 'video' && page.best.url !== url) {
          const inner = await bestVersion({ url: page.best.url, referer: page.finalUrl, alternates: page.best.alternates || [], declared, depth: 1 });
          if (inner.measured) return { ...inner, upgraded: true, original: null, referer: page.finalUrl, viaPage: true };
        }
      } catch {}
    }
    return { url, measured: false, tried: candidates.length };
  }
  // Imagem "maior" com menos bytes que uma menor do mesmo formato foi esticada pelo servidor: não é resolução de verdade.
  const genuine = valid.filter((r) => !valid.some((s) => s !== r && s.format === r.format && r.bytes && s.bytes
    && r.w * r.h >= s.w * s.h * 1.5 && r.bytes < s.bytes));
  genuine.sort((a, b) => b.w * b.h - a.w * a.h || b.bytes - a.bytes || (a.url === url ? -1 : b.url === url ? 1 : 0));
  const best = genuine[0];
  return {
    url: best.url,
    w: best.w,
    h: best.h,
    bytes: best.bytes,
    format: best.format,
    measured: true,
    upgraded: best.url !== url,
    original: original.ok ? { w: original.w, h: original.h } : null,
    tried: candidates.length,
  };
}

// Combina a pontuação heurística com o tamanho real medido para achar a foto principal de uma página de imagem.
async function pickMainImage(ranked, referer) {
  const top = ranked[0];
  if (!top) return null;
  if (top.kind === 'video') return top.score >= 20 ? top : null;
  const pool = ranked.filter((c) => c.kind !== 'video' && c.score > -20).slice(0, 6);
  const measured = await mapLimited(pool, 4, async (c) => ({ c, probe: await probeImage(c.url, referer) }));
  let best = null;
  for (const { c, probe } of measured) {
    if (!probe.ok) continue;
    const area = probe.w * probe.h;
    const sizeBonus = area ? Math.max(-40, Math.min(60, 10 * Math.log2(area / 40_000))) : 0;
    const aspect = probe.w && probe.h ? Math.max(probe.w / probe.h, probe.h / probe.w) : 1;
    const final = c.score + sizeBonus - (aspect > 4 ? 30 : 0);
    if (!best || final > best.final) best = { ...c, final: Math.round(final), w: probe.w, h: probe.h, bytes: probe.bytes };
  }
  if (best) return best.final >= 20 ? best : null;
  // Nada pôde ser medido (ex.: bloqueio de hotlink): decide só pela heurística.
  return top.score >= 20 ? top : null;
}

// Abre a página para onde a miniatura aponta e devolve a imagem principal dela.
async function resolveSecondary(url, referer, thumb, { render = 'auto' } = {}) {
  let current = url;
  let ref = referer;
  let title = '';
  let staticError = null;
  if (render !== 'always') {
    try {
      for (let hop = 0; hop < 4; hop++) {
        const page = await fetchPage(current, ref);
        if (page.mediaType) {
          return { finalUrl: page.finalUrl, title, best: { url: page.finalUrl, kind: page.mediaType.startsWith('video/') ? 'video' : 'hosted', score: 100 } };
        }
        title = pageTitle(page.html) || title;
        const best = await pickMainImage(rankCandidates(page.html, page.finalUrl, thumb), page.finalUrl);
        if (best) return { finalUrl: page.finalUrl, title, best };
        const redirect = findRedirect(page.html, page.finalUrl);
        if (!redirect || redirect === current) break;
        ref = page.finalUrl;
        current = redirect;
      }
    } catch (err) {
      if (err.auth || render === 'never' || !renderer.isInstalled()) throw err;
      staticError = err;
    }
  }
  if (render === 'never' || !renderer.isInstalled()) return { finalUrl: current, title, best: null };

  // A página da imagem só mostra a foto depois do JavaScript (ou bloqueou a leitura simples): abre no navegador.
  try {
    const rendered = await renderAndExtract(current, { scroll: false, scripts: true }, ref);
    const best = await pickMainImage(rankCandidates(rendered.html, rendered.finalUrl, thumb), rendered.finalUrl);
    return { finalUrl: rendered.finalUrl, title: rendered.title || title, best, rendered: true };
  } catch (err) {
    if (staticError && !err.auth) throw staticError;
    throw err;
  }
}

// ---------- URLs em sequência (fusker): image[001-100].jpg, foto[a-f].png ----------

function expandPattern(input, limit = MAX_EXPANDED_URLS) {
  const m = input.match(/\[(\d+)-(\d+)\]|\[([a-z])-([a-z])\]/i);
  if (!m) return [input];
  const values = [];
  if (m[1] !== undefined) {
    const from = parseInt(m[1], 10);
    const to = parseInt(m[2], 10);
    const width = m[1].length > 1 && m[1].startsWith('0') ? m[1].length : 0;
    const step = from <= to ? 1 : -1;
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
      values.push(String(i).padStart(width, '0'));
      if (values.length >= limit) break;
    }
  } else {
    const from = m[3].charCodeAt(0);
    const to = m[4].charCodeAt(0);
    const step = from <= to ? 1 : -1;
    for (let c = from; step > 0 ? c <= to : c >= to; c += step) values.push(String.fromCharCode(c));
  }
  const out = [];
  for (const value of values) {
    const replaced = input.slice(0, m.index) + value + input.slice(m.index + m[0].length);
    for (const url of expandPattern(replaced, limit - out.length)) {
      out.push(url);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function expandInputs(inputs) {
  const pages = [];
  const direct = [];
  const seen = new Set();
  for (const input of inputs) {
    for (const raw of expandPattern(String(input).trim(), MAX_EXPANDED_URLS - seen.size)) {
      const url = absoluteHttpUrl(raw);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const pathname = new URL(url).pathname;
      if (MEDIA_EXT.test(pathname)) direct.push({ url, kind: VIDEO_EXT.test(pathname) ? 'video' : 'linked' });
      else pages.push(url);
    }
    if (seen.size >= MAX_EXPANDED_URLS) break;
  }
  return { pages, direct };
}

// ---------- busca de imagens ----------

async function searchImages(provider, query, pages) {
  const q = encodeURIComponent(query);
  const results = [];
  if (provider === 'bing') {
    for (let p = 0; p < pages; p++) {
      const page = await fetchPage(`https://www.bing.com/images/async?q=${q}&first=${p * 35 + 1}&count=35&mmasync=1`, `https://www.bing.com/images/search?q=${q}`);
      if (!page.html) break;
      let added = 0;
      for (const m of page.html.matchAll(/\bm="([^"]+)"/g)) {
        try {
          const data = JSON.parse(decodeEntities(m[1]));
          const url = absoluteHttpUrl(data.murl);
          if (url) {
            results.push({ url, thumb: absoluteHttpUrl(data.turl), page: absoluteHttpUrl(data.purl), title: data.t || '' });
            added++;
          }
        } catch {}
      }
      if (!added) break;
    }
  } else if (provider === 'duckduckgo') {
    const home = await fetchPage(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`);
    const vqd = ((home.html || '').match(/vqd=["']?([\d-]+)["']?/) || [])[1];
    if (!vqd) throw new Error('o DuckDuckGo não liberou a busca agora; tente o Bing');
    let next = `https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${q}&vqd=${vqd}&f=,,,,,&p=1`;
    for (let p = 0; p < pages && next; p++) {
      const res = await fetchFrom(next, { referer: 'https://duckduckgo.com/', accept: 'application/json' });
      if (!res.ok) {
        await res.body?.cancel();
        if (!results.length) throw new Error(`DuckDuckGo respondeu HTTP ${res.status}`);
        break;
      }
      const data = await res.json();
      for (const r of data.results || []) {
        const url = absoluteHttpUrl(r.image);
        if (url) results.push({ url, thumb: absoluteHttpUrl(r.thumbnail), page: absoluteHttpUrl(r.url), title: r.title || '', w: r.width || 0, h: r.height || 0 });
      }
      next = data.next ? `https://duckduckgo.com/${data.next}&vqd=${vqd}` : null;
    }
  } else {
    throw new Error('provedor de busca desconhecido');
  }
  return [...new Map(results.map((r) => [r.url, r])).values()];
}

// ---------- nomes de arquivo ----------

const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

// ---------- nome de pasta a partir do título da página ----------

const TITLE_SEPARATORS = /\s+(?:[|–—·•»:]{1,2}|-{1,2})\s+/;
const GENERIC_TITLES = /^(home|início|inicio|página inicial|pagina inicial|homepage|index|untitled|sem título|sem titulo|search|pesquisa|busca|images|imagens|photos|fotos|gallery|galeria|forum|fórum)$/i;
const plainWord = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// "Aurora polar – Wikipédia, a enciclopédia livre" → "Aurora polar"; "Photos of aurora | Unsplash" → "Photos of aurora".
function suggestFolderName(title, pageUrl) {
  let host = '';
  let pathHint = '';
  try {
    const u = new URL(pageUrl);
    host = u.hostname.replace(/^www\./, '');
    pathHint = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
  } catch {}
  // Palavra que identifica o site: "wikipedia" em pt.wikipedia.org, "bing" em www.bing.com.
  const labels = host.split('.');
  const site = plainWord(labels.length > 1 ? labels[labels.length - 2] : host);
  const isSiteName = (part) => {
    const word = plainWord(part);
    if (!word || !site) return false;
    return site.length >= 3 ? word.includes(site) || site.includes(word) : word === site;
  };
  const clean = String(title || '').replace(/\s+/g, ' ').trim();
  let parts = clean.split(TITLE_SEPARATORS).map((p) => p.trim()).filter(Boolean);
  // Trilha de navegação ("Fórum » Viagens » Fotos de Ronda"): a parte mais específica é a última.
  if (/\s[»›>]\s/.test(clean)) parts = parts.reverse();
  let name = parts.find((p) => !isSiteName(p) && !GENERIC_TITLES.test(p)) || '';
  // Títulos de SEO longos ("Aurora Photos, Download The BEST Free…"): fica o primeiro trecho.
  if (name.length > 50 && name.includes(', ')) name = name.slice(0, name.indexOf(', '));
  if (!name && pathHint && !/^(index|default|home)(\.\w+)?$/i.test(pathHint)) {
    name = pathHint.replace(/\.\w{2,5}$/, '').replace(/[-_+]+/g, ' ').trim();
  }
  if (!name) name = host;
  if (name.length > 80) name = name.slice(0, 80).replace(/\s+\S*$/, '');
  // Pontuação proibida no Windows vira algo legível em vez de "_".
  name = name.replace(/\s*[:|]\s*/g, ' - ').replace(/[/\\]/g, '-').replace(/["<>?*]/g, '').replace(/\s+/g, ' ').trim();
  return sanitizeSegment(name, 80) || sanitizeSegment(host, 80) || 'Imagens';
}

function sanitizeSegment(text, max = 150) {
  let s = String(text || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, max).replace(/[. ]+$/, '').trim();
  if (!s || /^\.+$/.test(s)) return '';
  if (RESERVED_NAMES.test(s.split('.')[0])) s = `_${s}`;
  return s;
}

function contentDispositionName(header) {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*utf-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {}
  }
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

// Nome original: Content-Disposition, depois o nome visível na página (hosts que embaralham o nome), depois a URL.
function originalName(url, { disposition, nameHint } = {}) {
  for (const candidate of [contentDispositionName(disposition), nameHint]) {
    if (candidate && MEDIA_EXT.test(candidate.trim())) return path.win32.basename(path.posix.basename(candidate.trim()));
  }
  const parsed = new URL(url);
  const raw = path.posix.basename(parsed.pathname);
  if (!MEDIA_EXT.test(raw)) {
    // O nome do arquivo vem num parâmetro (ex.: th?id=OHR.Ronda_UHD.jpg ou download.php?file=foto.png).
    const fromQuery = [...parsed.searchParams.values()].find((v) => MEDIA_EXT.test(v));
    if (fromQuery) return path.win32.basename(path.posix.basename(fromQuery));
    // Endpoint do Bing sem extensão: o identificador da imagem é o melhor nome disponível.
    if (BING_IMAGE.test(url) && parsed.searchParams.get('id')) return parsed.searchParams.get('id').slice(0, 80);
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function fileNameFor(url, contentType, options = {}) {
  const original = sanitizeSegment(originalName(url, options)) || 'imagem';
  const parsed = path.parse(original);
  const typeExt = EXT_BY_TYPE[(contentType || '').split(';')[0].trim().toLowerCase()];
  let stem = parsed.name;
  let ext = parsed.ext.toLowerCase();
  if (!MEDIA_EXT.test(ext)) {
    stem = original;
    ext = typeExt || '';
  }
  const n = options.n != null && options.n !== '' ? String(options.n).padStart(Number(options.pad) || 0, '0') : '';
  const host = new URL(url).hostname.replace(/^www\./, '');
  const values = { name: stem, n, title: options.title || '', host };
  const base = sanitizeSegment(String(options.template || '{name}').replace(/\{(name|n|title|host)\}/g, (_, key) => values[key]));
  return (base || sanitizeSegment(stem) || 'imagem') + ext;
}

// ---------- download com validação, novas tentativas e retomada ----------

async function validateFile(file, expectedSize) {
  const { size } = await fsp.stat(file);
  if (!size) return 'arquivo vazio';
  if (expectedSize && size !== expectedSize) return `incompleto (${size} de ${expectedSize} bytes)`;
  const fh = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(32, size));
    await fh.read(head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(1024, size));
    await fh.read(tail, 0, tail.length, size - tail.length);
    if (/^\s*<(!doctype|html|head|body)/i.test(head.toString('latin1'))) return 'o servidor devolveu uma página HTML em vez do arquivo';
    if (head[0] === 0xff && head[1] === 0xd8) return tail.includes(Buffer.from([0xff, 0xd9])) ? null : 'JPEG truncado';
    if (head.subarray(0, 8).equals(PNG_SIGNATURE)) return tail.includes(Buffer.from('IEND')) ? null : 'PNG truncado';
    if (head.toString('latin1', 0, 4) === 'GIF8') return tail[tail.length - 1] === 0x3b ? null : 'GIF truncado';
    if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
      return head.readUInt32LE(4) + 8 <= size ? null : 'WebP truncado';
    }
    return null;
  } finally {
    await fh.close();
  }
}

function idleTimer(ms) {
  const controller = new AbortController();
  let timer;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`conexão parada por ${ms / 1000} s`)), ms);
  };
  touch();
  return { signal: controller.signal, touch, clear: () => clearTimeout(timer) };
}

const isRetriableStatus = (status) => status === 408 || status === 425 || status === 429 || status >= 500;

async function saveMedia(params) {
  const source = absoluteHttpUrl(params.url);
  if (!source) throw fatal('URL inválida');
  let dir = params.folder ? String(params.folder) : DEFAULT_FOLDER;
  if (!path.isAbsolute(dir)) throw fatal('a pasta precisa ser um caminho absoluto, como C:\\Users\\voce\\Imagens');
  const sub = sanitizeSegment(params.subfolder, 80);
  if (sub) dir = path.join(dir, sub);
  await fsp.mkdir(dir, { recursive: true });

  const attempts = Math.min(11, Math.max(1, (Number(params.retries) || 0) + 1));
  const validate = params.validate !== false;
  let handle = null;
  let file = null;
  let bytes = 0;
  let lastError = null;
  let resumed = 0;

  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await sleep(Math.max(Math.min(8000, 1000 * 2 ** (attempt - 2)), Math.min(30, lastError?.retryAfter || 0) * 1000));
      const release = await acquireHostSlot(source, 'download', DOWNLOAD_PER_HOST);
      const idle = idleTimer(IDLE_TIMEOUT_MS);
      try {
        const res = await fetchFrom(source, { referer: params.referer, accept: ACCEPT_MEDIA, signal: idle.signal, range: bytes ? `${bytes}-` : null });
        if (isLoginChallenge(res.status, res.headers.get('www-authenticate'))) {
          await res.body?.cancel();
          throw authError(res);
        }
        if (!res.ok) {
          await res.body?.cancel();
          if (isRetriableStatus(res.status)) {
            const retryAfter = Number(res.headers.get('retry-after')) || 0;
            const message = res.status === 429
              ? `HTTP 429: o site limitou as requisições${retryAfter ? ` e pediu ${retryAfter >= 120 ? `${Math.round(retryAfter / 60)} min` : `${retryAfter} s`} de espera; tente de novo depois (os já baixados são pulados)` : ''}`
              : `HTTP ${res.status}`;
            throw Object.assign(new Error(message), { retryAfter });
          }
          throw fatal(`HTTP ${res.status}`);
        }
        const type = (res.headers.get('content-type') || '').toLowerCase();
        if (!handle) {
          if (!type.startsWith('image/') && !type.startsWith('video/') && !MEDIA_EXT.test(new URL(res.url).pathname)) {
            await res.body?.cancel();
            throw fatal(`não é imagem nem vídeo (${type || 'sem tipo'})`);
          }
          const name = fileNameFor(res.url, type, { ...params, disposition: res.headers.get('content-disposition') });
          if (params.skipExisting) {
            const existing = path.join(dir, name);
            if (await fsp.access(existing).then(() => true, () => false)) {
              await res.body?.cancel();
              return { file: existing, bytes: 0, skipped: true };
            }
          }
          ({ handle, file } = await openUnique(dir, name));
        }
        if (bytes && res.status === 206) resumed++;
        else if (bytes) {
          // O servidor ignorou o pedido de retomada: recomeça do zero.
          await handle.truncate(0);
          bytes = 0;
        }
        const length = Number(res.headers.get('content-length')) || 0;
        const total = Number(((res.headers.get('content-range') || '').match(/\/(\d+)$/) || [])[1]) || 0;
        const expected = res.headers.get('content-encoding') ? 0 : res.status === 206 ? total || bytes + length : length;
        if (expected > MAX_FILE_BYTES) {
          await res.body?.cancel();
          throw fatal('arquivo maior que 4 GB');
        }
        for await (const chunk of res.body) {
          idle.touch();
          await handle.write(chunk, 0, chunk.length, bytes);
          bytes += chunk.length;
          if (bytes > MAX_FILE_BYTES) throw fatal('arquivo maior que 4 GB');
        }
        idle.clear();
        if (validate) {
          const problem = await validateFile(file, expected);
          if (problem) {
            await handle.truncate(0);
            bytes = 0;
            throw new Error(problem);
          }
        }
        await handle.close();
        handle = null;
        return { file, bytes, skipped: false, attempts: attempt, resumed };
      } catch (err) {
        idle.clear();
        if (err.fatal) throw err;
        lastError = err.name === 'TimeoutError' || err.name === 'AbortError' ? new Error('tempo esgotado') : err;
        // Espera longa pedida pelo site: não adianta gastar as tentativas agora.
        if (lastError.retryAfter > 60) break;
      } finally {
        release();
      }
    }
    throw lastError;
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    if (file) await fsp.unlink(file).catch(() => {});
    throw err;
  }
}

async function openUnique(dir, name) {
  const { name: stem, ext } = path.parse(name);
  for (let i = 0; i < 10_000; i++) {
    const file = path.join(dir, i ? `${stem} (${i})${ext}` : name);
    try {
      return { handle: await fsp.open(file, 'wx'), file };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw fatal('não foi possível escolher um nome de arquivo livre');
}

// ---------- servidor HTTP ----------

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 2_000_000) throw new Error('requisição grande demais');
  }
  return JSON.parse(text || '{}');
}

// Erros de página viram resposta normal ({ error } ou { needsAuth }) para a interface decidir o que fazer.
async function pageResult(work) {
  try {
    return await work();
  } catch (err) {
    if (err.auth) return { needsAuth: err.auth };
    return { error: err.name === 'TimeoutError' ? 'tempo esgotado' : err.message };
  }
}

async function handleThumb(res, query) {
  const url = absoluteHttpUrl(query.get('u'));
  if (!url) {
    res.writeHead(400);
    return res.end();
  }
  const upstream = await fetchFrom(url, { referer: query.get('r') || undefined, accept: ACCEPT_MEDIA });
  const type = upstream.headers.get('content-type') || '';
  if (!upstream.ok || !type.startsWith('image/')) {
    await upstream.body?.cancel();
    res.writeHead(502);
    return res.end();
  }
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox',
  });
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

function openPath(target) {
  const [cmd, args] =
    process.platform === 'win32' ? ['explorer.exe', [target]]
    : process.platform === 'darwin' ? ['open', [target]]
    : ['xdg-open', [target]];
  execFile(cmd, args, () => {});
}

function openBrowser(target) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', target], () => {});
  else openPath(target);
}

const routes = {
  'POST /api/expand': async (body) => expandInputs(Array.isArray(body.inputs) ? body.inputs.slice(0, 500) : []),
  'POST /api/scan-page': async (body) => {
    const url = absoluteHttpUrl(body.url);
    if (!url) return { error: 'URL inválida' };
    const render = ['auto', 'always', 'never'].includes(body.render) ? body.render : 'auto';
    return pageResult(async () => {
      const result = await scanPage(url, { scripts: body.scripts !== false, render, scroll: body.scroll !== false, maxScrolls: body.maxScrolls });
      return { ...result, folderName: suggestFolderName(result.title, result.finalUrl) };
    });
  },
  'POST /api/folder-name': async (body) => ({ name: suggestFolderName(body.title, body.url) }),
  'POST /api/resolve': async (body) => {
    const url = absoluteHttpUrl(body.url);
    if (!url) return { error: 'URL inválida' };
    const render = ['auto', 'always', 'never'].includes(body.render) ? body.render : 'auto';
    return pageResult(() => resolveSecondary(url, absoluteHttpUrl(body.referer) || undefined, absoluteHttpUrl(body.thumb), { render }));
  },
  'POST /api/browser': async () => ({ installed: renderer.isInstalled(), ...(await renderer.status()) }),
  'POST /api/best': async (body) => {
    const url = absoluteHttpUrl(body.url);
    if (!url) return { error: 'URL inválida' };
    const alternates = Array.isArray(body.alternates) ? body.alternates.slice(0, 20) : [];
    const declared = body.declared && Number(body.declared.w) > 0 && Number(body.declared.h) > 0 ? { w: Number(body.declared.w), h: Number(body.declared.h) } : null;
    return pageResult(() => bestVersion({ url, referer: absoluteHttpUrl(body.referer) || undefined, alternates, thumb: absoluteHttpUrl(body.thumb), declared, upgrade: body.upgrade !== false }));
  },
  'POST /api/search': async (body) => {
    const query = String(body.query || '').trim();
    if (!query) return { error: 'digite o que buscar' };
    const pages = Math.min(10, Math.max(1, Number(body.pages) || 1));
    return pageResult(async () => ({ images: await searchImages(body.provider, query, pages) }));
  },
  'POST /api/auth': async (body) => {
    const origin = new URL(String(body.origin)).origin;
    const username = String(body.username ?? '');
    const password = String(body.password ?? '');
    credentials.set(origin, `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
    credentialPairs.set(origin, { username, password });
    return { ok: true };
  },
  'POST /api/save': async (body) => saveMedia(body),
  'POST /api/open-folder': async (body) => {
    const dir = body.folder ? String(body.folder) : DEFAULT_FOLDER;
    if (!path.isAbsolute(dir)) throw fatal('a pasta precisa ser um caminho absoluto');
    await fsp.mkdir(dir, { recursive: true });
    openPath(dir);
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  // Só aceita o próprio host local (protege contra DNS rebinding).
  if (![`${HOST}:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) {
    res.writeHead(403);
    return res.end();
  }
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const config = JSON.stringify({ token: TOKEN, defaultFolder: DEFAULT_FOLDER });
      const html = (await fsp.readFile(path.join(__dirname, 'web-legacy', 'index.html'), 'utf8')).replace('__CONFIG__', () => config);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (!url.pathname.startsWith('/api/')) {
      res.writeHead(404);
      return res.end();
    }
    // Toda a API exige o token que só a página servida acima conhece.
    if ((url.searchParams.get('t') || req.headers['x-token']) !== TOKEN) return sendJson(res, 403, { error: 'token inválido' });
    if (req.method === 'GET' && url.pathname === '/api/thumb') return await handleThumb(res, url.searchParams);
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return sendJson(res, 404, { error: 'rota desconhecida' });
    sendJson(res, 200, await route(await readJson(req)));
  } catch (err) {
    if (res.headersSent) return res.destroy();
    sendJson(res, err.fatal ? 422 : 500, { error: err.name === 'TimeoutError' ? 'tempo esgotado' : err.message, auth: err.auth });
  }
});

// Chamada direta usada pelo app de desktop (mesma semântica da API HTTP, sem servidor).
async function call(name, body = {}) {
  const route = routes[`POST /api/${name}`];
  if (!route) return { ok: false, error: 'rota desconhecida' };
  try {
    return { ok: true, data: await route(body) };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'tempo esgotado' : err.message, auth: err.auth };
  }
}

// Busca uma miniatura com o referer da página (contorna bloqueio de hotlink). Devolve null se não for imagem.
async function fetchThumb(url, referer) {
  const target = absoluteHttpUrl(url);
  if (!target) return null;
  const upstream = await fetchFrom(target, { referer: absoluteHttpUrl(referer) || undefined, accept: ACCEPT_MEDIA });
  const type = upstream.headers.get('content-type') || '';
  if (!upstream.ok || !type.startsWith('image/')) {
    await upstream.body?.cancel();
    return null;
  }
  return { type, body: upstream.body };
}

// Modo servidor HTTP: usado só pelos testes automatizados (o app de desktop chama `call` direto).
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const address = `http://${HOST}:${PORT}/`;
    console.log(`Baixador de Imagens rodando em ${address}`);
    console.log('Feche esta janela (ou Ctrl+C) para encerrar.');
    if (!process.env.NO_OPEN) openBrowser(address);
  });
  // Fecha o navegador headless junto com o app.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(signal, () => renderer.shutdown().finally(() => process.exit(0)));
  }
}

module.exports = {
  extractPage, rankCandidates, findRedirect, expandPattern, expandInputs, fileNameFor, largestFromSrcset,
  validateFile, stemOf, imageSize, upgradeCandidates, bestVersion, pickMainImage, NEED_MORE,
  findMediaUrls, needsRendering, mergeScans, scanPage, resolveSecondary, collapseVariants, canonicalKey,
  call, fetchThumb, DEFAULT_FOLDER, shutdown: () => renderer.shutdown(), suggestFolderName,
};
