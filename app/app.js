// Interface do Baixador de Imagens (processo isolado; fala com o motor só por window.bid).
'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const desktop = window.bid;
const icon = (name, cls) => window.iconSvg(name, cls);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- configurações ----------

const SETTINGS_KEY = 'bid.settings.v1';
const DEFAULTS = {
  mode: 'pages',
  provider: 'bing',
  searchPages: '2',
  minSide: 300,
  kinds: { linked: true, hosted: true, embedded: true, script: true, search: true, meta: false },
  types: { jpg: true, png: true, gif: true, webp: true, other: true, video: true },
  density: 'large',
  folder: '',
  subfolder: 'title',
  skipExisting: true,
  concurrency: 8,
  retries: 3,
  validate: true,
  template: '{name}',
  seqStart: 1,
  seqPad: 3,
  followSecondary: true,
  maxSecondary: 500,
  paginate: false,
  maxPages: 10,
  scripts: true,
  bestVersion: true,
  render: 'auto',
  scroll: true,
  maxScrolls: 15,
};

const SETTINGS_VERSION = 2;

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch {}
  // v2: uma pasta por página passou a ser o padrão (a v1 salvava "nenhuma" sem o usuário ter escolhido).
  if ((saved.version || 1) < 2 && saved.subfolder === 'none') saved.subfolder = 'title';
  return { ...DEFAULTS, ...saved, version: SETTINGS_VERSION, kinds: { ...DEFAULTS.kinds, ...saved.kinds }, types: { ...DEFAULTS.types, ...saved.types } };
}

const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

const KIND_INFO = {
  linked: { label: 'Link direto', desc: 'A miniatura aponta para o arquivo em tamanho cheio', short: 'link' },
  hosted: { label: 'Página da imagem', desc: 'Foto principal da página aberta pela miniatura', short: 'página' },
  embedded: { label: 'Exibida na página', desc: 'Imagens mostradas na própria página', short: 'na página' },
  script: { label: 'Scripts e rede', desc: 'Citadas no código, em dados ou carregadas pela página', short: 'script' },
  search: { label: 'Busca', desc: 'Resultados de busca de imagens', short: 'busca' },
  meta: { label: 'Capa da página', desc: 'og:image e twitter:image', short: 'capa' },
};
const KIND_RANK = { linked: 5, hosted: 5, video: 5, search: 4, embedded: 3, meta: 2, script: 1 };
const TYPE_INFO = { jpg: 'JPG', png: 'PNG', gif: 'GIF', webp: 'WebP', other: 'Outros formatos', video: 'Vídeos' };
const SIZE_PRESETS = [
  { value: 0, label: 'Qualquer', sub: 'sem filtro' },
  { value: 300, label: '300 px', sub: 'sem ícones' },
  { value: 800, label: '800 px', sub: 'médias' },
  { value: 1280, label: 'HD', sub: '1280 px+' },
  { value: 1920, label: 'Full HD', sub: '1920 px+' },
  { value: 3840, label: '4K', sub: '3840 px+' },
];
const EXAMPLES = [
  { icon: 'link', label: 'Wikipedia · Aurora polar', url: 'https://pt.wikipedia.org/wiki/Aurora_polar' },
  { icon: 'link', label: 'Unsplash · montanhas', url: 'https://unsplash.com/s/photos/mountains' },
  { icon: 'search', label: 'Buscar “aurora boreal”', search: 'aurora boreal' },
];

const state = {
  items: [],
  byUrl: new Map(),
  busy: false,
  cancel: false,
  phase: 'welcome',
  authPrompts: new Map(),
  skippedOrigins: new Set(),
  lastToggled: null,
  lightbox: null,
  info: { defaultFolder: '' },
  log: [],
  // Uma entrada por página colada (ou busca): { key, name (editável), suggested }.
  groups: new Map(),
};

// ---------- motor ----------

async function core(name, body) {
  const r = await desktop.call(name, body);
  if (!r.ok) throw Object.assign(new Error(r.error || 'erro desconhecido'), { auth: r.auth });
  return r.data;
}

// Repete a chamada depois de pedir usuário e senha quando o site exige autenticação.
async function coreWithAuth(name, body) {
  let result = await core(name, body);
  if (result.needsAuth) {
    const ok = await askCredentials(result.needsAuth);
    result = ok ? await core(name, body) : { error: 'autenticação não informada' };
    if (result.needsAuth) result = { error: 'usuário ou senha recusados' };
  }
  return result;
}

// ---------- utilitários ----------

const formatBytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : n ? `${n} B` : '');
const plural = (n, one, many) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
const thumbUrl = (url, referer, full = false) => `thumb://img/?u=${encodeURIComponent(url)}&r=${encodeURIComponent(referer || '')}${full ? '&full=1' : ''}`;

function typeOf(url, kind) {
  let ext = '';
  try {
    const u = new URL(url);
    ext = (u.pathname.match(/\.([a-z0-9]+)$/i) || [])[1] || ([...u.searchParams.values()].join(' ').match(/\.(jpe?g|png|gif|webp|mp4|webm)\b/i) || [])[1] || '';
  } catch {}
  ext = ext.toLowerCase();
  if (kind === 'video' || ['mp4', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'mpg', 'mpeg', 'mov', 'flv', '3gp', 'ogv'].includes(ext)) return 'video';
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'jfif') return 'jpg';
  return ['png', 'gif', 'webp'].includes(ext) ? ext : 'other';
}

function displayName(item) {
  if (item.nameHint) return item.nameHint;
  try {
    const u = new URL(item.url);
    const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    const id = u.searchParams.get('id');
    return decodeURIComponent(last === 'th' && id ? id : last);
  } catch {
    return item.url;
  }
}

function qualityTag(w, h) {
  const side = Math.max(w, h);
  if (side >= 3840) return { label: '4K', cls: 'tag-4k' };
  if (side >= 2560) return { label: 'QHD', cls: '' };
  if (side >= 1920) return { label: 'Full HD', cls: '' };
  if (side >= 1280) return { label: 'HD', cls: '' };
  return null;
}

function normalizeUrl(raw) {
  const value = raw.trim();
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : 'https://' + value;
}

// Fila com N tarefas em paralelo; respeita o cancelamento.
function drain(queue, workers, handler) {
  return new Promise((resolve) => {
    let active = 0;
    const pump = () => {
      if (state.cancel) queue.length = 0;
      if (!queue.length && !active) return resolve();
      while (active < workers && queue.length) {
        const job = queue.shift();
        active++;
        handler(job)
          .catch((err) => log(err.message, 'error'))
          .finally(() => { active--; pump(); });
      }
    };
    pump();
  });
}

// ---------- atividade, registro e avisos ----------

const pill = {
  start(text) {
    $('#pill').hidden = false;
    $('#pillText').textContent = text;
    $('#pillCount').textContent = '';
    $('.pill-bar').classList.add('indeterminate');
  },
  update(text, done, total) {
    $('#pillText').textContent = text;
    if (total) {
      $('.pill-bar').classList.remove('indeterminate');
      $('#pillBar').style.width = `${Math.min(100, (done / total) * 100)}%`;
      $('#pillCount').textContent = `${done}/${total}`;
    } else {
      $('.pill-bar').classList.add('indeterminate');
      $('#pillCount').textContent = '';
    }
  },
  stop() {
    $('#pill').hidden = true;
    $('#pillBar').style.width = '0';
  },
};

const LOG_ICON = { info: 'info', ok: 'check-circle', error: 'alert', warn: 'alert' };

function log(text, level = 'info') {
  const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.log.unshift({ text, level, time });
  if (state.log.length > 500) state.log.length = 500;
  const li = document.createElement('li');
  li.className = level;
  li.innerHTML = `${icon(LOG_ICON[level])}<div><div class="log-text"></div><time>${time}</time></div>`;
  li.querySelector('.log-text').textContent = text;
  $('#log').prepend(li);
  $('#logEmpty').hidden = true;
  if (level === 'error' && $('#activity').hidden) $('#activityDot').hidden = false;
}

function toast({ title, detail = '', level = 'ok', actionLabel, action, timeout = 7000 }) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  const iconName = { ok: 'check', error: 'alert', info: 'info', warn: 'alert' }[level];
  el.innerHTML = `<span class="toast-icon">${icon(iconName)}</span><div class="toast-text"><span></span><small></small></div>`;
  el.querySelector('.toast-text span').textContent = title;
  el.querySelector('.toast-text small').textContent = detail;
  if (actionLabel) {
    const button = document.createElement('button');
    button.className = 'btn btn-ghost btn-sm';
    button.textContent = actionLabel;
    button.addEventListener('click', () => { action(); close(); });
    el.append(button);
  }
  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  };
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  $('#toasts').append(el);
  setTimeout(close, timeout);
}

// ---------- controles segmentados ----------

function setSegment(container, value, attr = 'value') {
  for (const button of $$('button', container)) button.setAttribute('aria-selected', String(button.dataset[attr] === value));
  positionThumb(container);
}

function positionThumb(container) {
  const selected = $('button[aria-selected="true"]', container);
  if (!selected || !selected.offsetWidth) return;
  container.style.setProperty('--thumb-x', `${selected.offsetLeft}px`);
  container.style.setProperty('--thumb-w', `${selected.offsetWidth}px`);
}

// ---------- barra de comando ----------

const input = $('#input');

// Cada modo guarda o próprio texto (links não vão parar na busca e vice-versa).
const drafts = { pages: '', search: '' };

function setMode(mode) {
  if (settings.mode !== mode) {
    drafts[settings.mode] = input.value;
    input.value = drafts[mode] || '';
  }
  settings.mode = mode;
  saveSettings();
  setSegment($('#modeSwitch'), mode, 'mode');
  const search = mode === 'search';
  $('#commandIcon').dataset.icon = search ? 'search' : 'link';
  hydrateIcons($('#commandBox'));
  $('#searchOptions').hidden = !search;
  $('#goLabel').textContent = search ? 'Buscar' : 'Escanear';
  input.placeholder = search ? 'O que você quer encontrar? Ex.: aurora boreal, Lisboa, arquitetura' : 'Cole o link de uma galeria, página ou imagem';
  renderHint();
  autoGrow();
}

function renderHint(clipboardUrl) {
  const hint = $('#hint');
  if (clipboardUrl) {
    let host = clipboardUrl;
    try { host = new URL(clipboardUrl).hostname.replace(/^www\./, ''); } catch {}
    hint.innerHTML = `Link copiado de <b>${escapeHtml(host)}</b> · <button class="hint-action" id="useClipboard">Usar e escanear</button>`;
    $('#useClipboard').addEventListener('click', () => { input.value = clipboardUrl; autoGrow(); submit(); });
    return;
  }
  hint.innerHTML = settings.mode === 'search'
    ? 'Busca imagens no Bing ou no DuckDuckGo · cada página traz cerca de 35 resultados'
    : 'Uma URL por linha · sequências como <code>foto[001-120].jpg</code> · <code>Shift+Enter</code> quebra a linha · ou arraste um link para a janela';
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
}

async function suggestClipboard() {
  if (settings.mode !== 'pages' || input.value.trim() || state.busy) return renderHint();
  try {
    const text = (await desktop.readClipboard()).trim();
    renderHint(/^https?:\/\/\S+$/i.test(text) && text.length < 2000 ? text : null);
  } catch {
    renderHint();
  }
}

function submit() {
  if (state.busy) return;
  if (settings.mode === 'search') search();
  else scan();
}

// ---------- filtros ----------

function passes(item) {
  if (!settings.kinds[item.kind === 'video' ? item.origin : item.kind]) return false;
  if (!settings.types[item.type]) return false;
  if (item.status === 'failed') return false;
  if (item.type !== 'video' && item.w && Math.max(item.w, item.h) < settings.minSide) return false;
  return true;
}

const visibleItems = () => state.items.filter(passes);

function applyFilters() {
  for (const item of state.items) item.el.hidden = !passes(item);
  refreshSummary();
}

function renderFilterControls() {
  const preset = SIZE_PRESETS.find((p) => p.value === settings.minSide);
  $('#sizeLabel').textContent = settings.minSide ? (preset && preset.value >= 1280 ? preset.label : `≥ ${settings.minSide} px`) : 'qualquer';
  $('#chipSize').classList.toggle('active', settings.minSide !== DEFAULTS.minSide);
  $('#minSideCustom').value = settings.minSide;
  for (const button of $$('#sizePresets .preset')) button.setAttribute('aria-pressed', String(Number(button.dataset.value) === settings.minSide));

  const typesOn = Object.values(settings.types).filter(Boolean).length;
  $('#typeLabel').textContent = typesOn === Object.keys(TYPE_INFO).length ? 'todos' : `${typesOn} de ${Object.keys(TYPE_INFO).length}`;
  $('#chipType').classList.toggle('active', typesOn !== Object.keys(TYPE_INFO).length);

  const kindsChanged = Object.keys(KIND_INFO).some((k) => settings.kinds[k] !== DEFAULTS.kinds[k]);
  const kindsOn = Object.values(settings.kinds).filter(Boolean).length;
  $('#sourceLabel').textContent = kindsChanged ? `${kindsOn} de ${Object.keys(KIND_INFO).length}` : 'padrão';
  $('#chipSource').classList.toggle('active', kindsChanged);

  // Contagens por tipo e por origem.
  const countBy = (fn) => state.items.reduce((acc, i) => { const k = fn(i); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  const typeCounts = countBy((i) => i.type);
  const kindCounts = countBy((i) => (i.kind === 'video' ? i.origin : i.kind));
  for (const el of $$('#typeList [data-count]')) el.textContent = typeCounts[el.dataset.count] || '';
  for (const el of $$('#sourceList [data-count]')) el.textContent = kindCounts[el.dataset.count] || '';
}

function buildFilterPopovers() {
  $('#sizePresets').innerHTML = SIZE_PRESETS.map((p) => `<button class="preset" data-value="${p.value}"><strong>${p.label}</strong><span>${p.sub}</span></button>`).join('');
  for (const button of $$('#sizePresets .preset')) {
    button.addEventListener('click', () => setMinSide(Number(button.dataset.value)));
  }
  $('#minSideCustom').addEventListener('change', (e) => setMinSide(Math.max(0, Number(e.target.value) || 0)));

  const checkItem = (group, key, label, desc) => `
    <label class="check-item">
      <input type="checkbox" data-group="${group}" data-key="${key}">
      <span class="check-box">${icon('check')}</span>
      <span class="check-text">${label}${desc ? `<small>${desc}</small>` : ''}</span>
      <span class="check-count" data-count="${key}"></span>
    </label>`;
  $('#typeList').innerHTML = Object.entries(TYPE_INFO).map(([k, label]) => checkItem('types', k, label)).join('');
  $('#sourceList').innerHTML = Object.entries(KIND_INFO).map(([k, info]) => checkItem('kinds', k, info.label, info.desc)).join('');
  for (const box of $$('.check-list input')) {
    box.checked = settings[box.dataset.group][box.dataset.key];
    box.addEventListener('change', () => {
      settings[box.dataset.group][box.dataset.key] = box.checked;
      saveSettings();
      renderFilterControls();
      applyFilters();
    });
  }
}

function setMinSide(value) {
  settings.minSide = value;
  saveSettings();
  renderFilterControls();
  applyFilters();
}

function resetFilters() {
  settings.minSide = 0;
  settings.kinds = Object.fromEntries(Object.keys(KIND_INFO).map((k) => [k, true]));
  settings.types = Object.fromEntries(Object.keys(TYPE_INFO).map((k) => [k, true]));
  saveSettings();
  for (const box of $$('.check-list input')) box.checked = true;
  renderFilterControls();
  applyFilters();
}

// ---------- galeria ----------

function makeCard(item) {
  const el = document.createElement('div');
  el.className = 'card loading';
  el.tabIndex = 0;
  el.innerHTML = `<div class="media"></div>
    <button class="check" aria-label="Selecionar">${icon('check')}</button>
    <div class="tags"></div>
    <div class="caption"><span class="name"></span><span class="meta"></span></div>`;
  item.el = el;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.check') || e.ctrlKey || e.shiftKey) return toggleItem(item, e.shiftKey);
    openLightbox(item);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); toggleItem(item, e.shiftKey); }
    if (e.key === 'Enter') openLightbox(item);
  });
  renderCard(item);
  showPreview(item);
  return el;
}

function renderCard(item) {
  const el = item.el;
  el.classList.toggle('selected', item.checked);
  el.title = item.url;
  $('.name', el).textContent = displayName(item);
  const parts = [];
  if (item.type === 'video') parts.push('vídeo');
  else if (item.measuring) parts.push('medindo resolução…');
  else if (item.w && item.h) parts.push(`${item.w} × ${item.h}`);
  else if (item.unverified) parts.push('original');
  if (item.bytes) parts.push(formatBytes(item.bytes));
  if (item.unverified && item.w) parts.push('declarado');
  $('.meta', el).textContent = parts.join(' · ') || ' ';

  const tags = [];
  const quality = item.w ? qualityTag(item.w, item.h) : null;
  if (item.upgraded) {
    const why = item.betterQuality ? 'Versão de melhor qualidade encontrada' : item.originalSize ? `Versão maior encontrada (a página mostrava ${item.originalSize})` : 'Versão maior encontrada';
    tags.push(`<span class="tag tag-up" title="${escapeHtml(why)}">${icon('arrow-up')}</span>`);
  }
  if (quality) tags.push(`<span class="tag ${quality.cls}">${quality.label}</span>`);
  if (!quality && item.type === 'video') tags.push('<span class="tag tag-kind">vídeo</span>');
  $('.tags', el).innerHTML = tags.join('');

  let stateEl = $('.state', el);
  const stateName = item.saveState;
  el.classList.toggle('has-state', !!stateName);
  if (!stateName) { stateEl?.remove(); return; }
  if (!stateEl) {
    stateEl = document.createElement('span');
    el.append(stateEl);
  }
  stateEl.className = `state ${stateName}`;
  stateEl.title = item.saveTitle || '';
  stateEl.innerHTML = stateName === 'working' ? '<span class="spinner"></span>' : icon({ saved: 'check', error: 'x', skipped: 'check' }[stateName]);
}

// Mostra a menor imagem disponível (miniatura da página, ou a própria imagem reduzida pelo app).
function showPreview(item) {
  const media = $('.media', item.el);
  const display = item.type === 'video' ? item.thumb : item.thumb || item.url;
  if (media.dataset.src === display && display) return;
  media.dataset.src = display || '';
  media.replaceChildren();
  if (item.type === 'video' && !$('.play-glyph', item.el)) {
    const glyph = document.createElement('div');
    glyph.className = 'play-glyph';
    glyph.innerHTML = `<span>${icon('play')}</span>`;
    item.el.append(glyph);
  }
  if (!display) {
    item.el.classList.remove('loading');
    media.innerHTML = `<div class="placeholder">${icon(item.type === 'video' ? 'play' : 'image')}</div>`;
    return;
  }
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.draggable = false;
  img.addEventListener('load', () => {
    img.classList.add('loaded');
    item.el.classList.remove('loading');
  });
  img.addEventListener('error', () => {
    item.el.classList.remove('loading');
    media.innerHTML = `<div class="placeholder">${icon(item.type === 'video' ? 'play' : 'image')}</div>`;
    // Sem prévia e sem medição: provavelmente não é uma imagem acessível.
    if (!item.measuring && !item.w && item.type !== 'video' && display === item.url && item.status !== 'ok') {
      item.status = 'failed';
      item.el.hidden = true;
      refreshSummary();
    }
  });
  img.src = thumbUrl(display, item.page);
  media.append(img);
}

function toggleItem(item, range) {
  const visible = visibleItems();
  if (range && state.lastToggled && visible.includes(state.lastToggled)) {
    const [a, b] = [visible.indexOf(state.lastToggled), visible.indexOf(item)].sort((x, y) => x - y);
    const value = state.lastToggled.checked;
    for (const it of visible.slice(a, b + 1)) { it.checked = value; renderCard(it); }
  } else {
    item.checked = !item.checked;
    renderCard(item);
  }
  state.lastToggled = item;
  refreshSummary();
}

function setSelection(fn) {
  for (const item of visibleItems()) { item.checked = fn(item); renderCard(item); }
  refreshSummary();
}

function refreshSummary() {
  const visible = visibleItems();
  const selected = visible.filter((i) => i.checked);
  const bytes = selected.reduce((sum, i) => sum + (i.bytes || 0), 0);
  $('#summary').innerHTML = `<strong>${visible.length.toLocaleString('pt-BR')}</strong> ${visible.length === 1 ? 'imagem' : 'imagens'}`
    + (visible.length ? `<span class="sep">·</span>${selected.length.toLocaleString('pt-BR')} ${selected.length === 1 ? 'selecionada' : 'selecionadas'}` : '')
    + (bytes ? `<span class="sep">·</span>${formatBytes(bytes)}` : '')
    + (state.items.length > visible.length ? `<span class="sep">·</span>${state.items.length - visible.length} ocultas pelos filtros` : '');
  $('#downloadLabel').textContent = selected.length ? `Baixar ${selected.length.toLocaleString('pt-BR')}` : 'Baixar';
  $('#download').disabled = state.busy || !selected.length;
  $('#gallery').classList.toggle('partial', selected.length > 0 && selected.length < visible.length);
  $('#toolbar').hidden = !state.items.length;
  renderFilterControls();
  renderDest();
  renderEmpty();
}

// ---------- estados vazios ----------

function renderEmpty() {
  const empty = $('#empty');
  const visible = visibleItems().length;
  if (state.items.length && visible) {
    empty.hidden = true;
    return;
  }
  empty.hidden = false;
  empty.classList.toggle('compact', state.phase !== 'welcome');

  if (state.phase === 'welcome') {
    empty.innerHTML = `
      <div class="art"><span></span><span></span><span></span><div class="art-badge">${icon('download')}</div></div>
      <h1>Baixe imagens em alta resolução</h1>
      <p>Cole o link de uma galeria, fórum ou página, ou faça uma busca. O app encontra as fotos, escolhe sozinho a maior versão de cada uma e baixa tudo de uma vez.</p>
      <div class="examples">${EXAMPLES.map((ex, i) => `<button class="example" data-example="${i}">${icon(ex.icon)}${escapeHtml(ex.label)}</button>`).join('')}</div>
      <div class="features">
        <span>${icon('sparkles')}Maior resolução automática</span>
        <span>${icon('globe')}Páginas em JavaScript</span>
        <span>${icon('download')}Downloads paralelos e retomáveis</span>
      </div>`;
    for (const button of $$('[data-example]', empty)) {
      button.addEventListener('click', () => {
        const ex = EXAMPLES[Number(button.dataset.example)];
        setMode(ex.search ? 'search' : 'pages');
        input.value = ex.search || ex.url;
        autoGrow();
        submit();
      });
    }
    return;
  }
  if (state.phase === 'scanning' && !state.items.length) {
    empty.hidden = true;
    return;
  }
  if (!state.items.length) {
    empty.innerHTML = `
      <h1>Nenhuma imagem encontrada</h1>
      <p>A página pode montar as fotos só depois de carregar, exigir login ou bloquear programas. Tente abrir com o navegador invisível ou veja os detalhes em Atividade.</p>
      <div class="examples">
        <button class="btn btn-primary" id="retryBrowser">${icon('globe')}Tentar com o navegador</button>
        <button class="btn" id="openActivity">${icon('activity')}Ver atividade</button>
      </div>`;
    $('#retryBrowser').addEventListener('click', () => scan({ render: 'always' }));
    $('#openActivity').addEventListener('click', () => openDrawer('activity'));
    return;
  }
  empty.innerHTML = `
    <h1>${plural(state.items.length, 'imagem escondida', 'imagens escondidas')} pelos filtros</h1>
    <p>${escapeHtml(filterReasons())}</p>
    <div class="examples"><button class="btn btn-primary" id="showAll">${icon('maximize')}Mostrar todas</button></div>`;
  $('#showAll').addEventListener('click', resetFilters);
}

function filterReasons() {
  const small = state.items.filter((i) => i.type !== 'video' && i.w && Math.max(i.w, i.h) < settings.minSide).length;
  const kind = state.items.filter((i) => !settings.kinds[i.kind === 'video' ? i.origin : i.kind]).length;
  const type = state.items.filter((i) => !settings.types[i.type]).length;
  const reasons = [
    small && `${small} menor(es) que ${settings.minSide} px`,
    kind && `${kind} de origem desmarcada`,
    type && `${type} de tipo desmarcado`,
  ].filter(Boolean);
  return reasons.length ? `Motivo: ${reasons.join(', ')}.` : 'Ajuste os filtros de tamanho, tipo ou origem.';
}

// ---------- itens ----------

function mergeFound(target, found) {
  if ((KIND_RANK[found.kind] || 0) > (KIND_RANK[target.kind] || 0)) {
    target.kind = found.kind;
    if (found.kind !== 'video') target.origin = found.kind;
  }
  for (const key of ['thumb', 'nameHint', 'title', 'declared', 'group']) if (found[key] && !target[key]) target[key] = found[key];
  if (found.alternates?.length) target.alternates = [...new Set([...(target.alternates || []), ...found.alternates])];
  renderCard(target);
}

function addItem(found) {
  const existing = state.byUrl.get(found.url);
  if (existing) return mergeFound(existing, found);
  const type = typeOf(found.url, found.kind);
  const item = {
    ...found,
    type,
    origin: found.kind === 'video' ? (found.via === 'hosted' ? 'hosted' : 'linked') : found.kind,
    checked: true,
    status: 'loading',
    w: found.w || 0,
    h: found.h || 0,
    measuring: type !== 'video',
  };
  state.items.push(item);
  state.byUrl.set(item.url, item);
  $('#gallery').append(makeCard(item));
  item.el.hidden = !passes(item);
  scheduleSummary();
}

let summaryTimer = null;
function scheduleSummary() {
  if (summaryTimer) return;
  summaryTimer = requestAnimationFrame(() => { summaryTimer = null; refreshSummary(); });
}

function removeItem(item) {
  item.el.remove();
  state.items.splice(state.items.indexOf(item), 1);
  if (state.byUrl.get(item.url) === item) state.byUrl.delete(item.url);
}

function resetResults() {
  state.items = [];
  state.byUrl = new Map();
  state.skippedOrigins = new Set();
  state.lastToggled = null;
  state.groups = new Map();
  $('#gallery').replaceChildren();
  renderDest();
}

// Grupo = página colada pelo usuário (ou busca). Cada um vira uma subpasta com nome sugerido e editável.
function ensureGroup(key, suggested) {
  if (!state.groups.has(key)) {
    const name = String(suggested || '').trim() || 'Imagens';
    state.groups.set(key, { key, name, suggested: name });
    renderDest();
  }
  return key;
}

// O título real chega depois; troca a sugestão provisória se o usuário ainda não editou o nome.
function suggestGroupName(key, suggested) {
  const group = state.groups.get(key);
  const name = String(suggested || '').trim();
  if (!group || !name || group.suggested === name) return;
  if (group.name === group.suggested) group.name = name;
  group.suggested = name;
  renderDest();
}

// Subpasta onde um item será salvo, conforme o modo escolhido.
function subfolderFor(item) {
  if (settings.subfolder === 'title') return state.groups.get(item.group)?.name || item.title || '';
  if (settings.subfolder === 'host') {
    try { return new URL(item.page || item.url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }
  return '';
}

// Aplica a medição: troca pela versão maior e junta itens que eram a mesma imagem em tamanhos diferentes.
function applyBest(item, r) {
  item.measuring = false;
  if (state.byUrl.get(item.url) !== item) return false;
  if (!r || r.error || !r.measured) {
    item.status = 'unknown';
    renderCard(item);
    showPreview(item);
    return false;
  }
  const oldUrl = item.url;
  let target = item;
  if (r.url !== oldUrl) {
    const other = state.byUrl.get(r.url);
    if (other) {
      removeItem(item);
      mergeFound(other, { ...item, thumb: item.thumb || oldUrl });
      target = other;
    } else {
      state.byUrl.delete(oldUrl);
      item.url = r.url;
      item.type = typeOf(r.url, item.kind);
      item.thumb = item.thumb || oldUrl;
      state.byUrl.set(r.url, item);
      item.upgraded = true;
      // Mesmas dimensões, mais bytes: a troca foi por menos compressão, não por mais pixels.
      item.betterQuality = !!r.original && r.original.w === r.w && r.original.h === r.h;
      if (r.original && !item.betterQuality) item.originalSize = `${r.original.w} × ${r.original.h}`;
    }
    if (r.referer) target.page = r.referer;
  }
  target.w = r.w;
  target.h = r.h;
  target.bytes = r.bytes;
  target.unverified = !!r.unverified;
  target.status = 'ok';
  renderCard(target);
  showPreview(target);
  target.el.hidden = !passes(target);
  return r.url !== oldUrl;
}

async function measureAll() {
  const queue = state.items.filter((i) => i.measuring);
  if (!queue.length) return 0;
  const total = queue.length;
  let done = 0;
  let upgraded = 0;
  const verb = settings.bestVersion ? 'Procurando a maior versão' : 'Medindo';
  pill.update(`${verb} de cada imagem`, 0, total);
  await drain(queue, 6, async (item) => {
    try {
      const r = await core('best', { url: item.url, referer: item.page, alternates: item.alternates || [], thumb: item.thumb, declared: item.declared, upgrade: settings.bestVersion });
      if (applyBest(item, r)) upgraded++;
    } catch {
      applyBest(item, null);
    } finally {
      done++;
      pill.update(`${verb} de cada imagem${upgraded ? ` · ${upgraded} trocada(s) por uma maior` : ''}`, done, total);
      scheduleSummary();
    }
  });
  for (const item of state.items) {
    if (!item.measuring) continue;
    item.measuring = false;
    renderCard(item);
  }
  return upgraded;
}

// ---------- escanear ----------

function setBusy(busy) {
  state.busy = busy;
  $('#go').disabled = busy;
  if (!busy) pill.stop();
  refreshSummary();
}

async function scan(overrides = {}) {
  const inputs = [...new Set(input.value.split(/\s+/).map(normalizeUrl).filter(Boolean))];
  if (!inputs.length) {
    input.focus();
    return toast({ title: 'Cole um link para escanear', level: 'info', timeout: 3500 });
  }
  closeOverlays();
  resetResults();
  state.phase = 'scanning';
  state.cancel = false;
  setBusy(true);
  pill.start('Lendo a página…');
  const options = {
    followSecondary: settings.followSecondary,
    maxSecondary: Number(settings.maxSecondary) || 500,
    paginate: settings.paginate,
    maxPages: Number(settings.maxPages) || 10,
    scripts: settings.scripts,
    render: overrides.render || settings.render,
    scroll: settings.scroll,
    maxScrolls: Number(settings.maxScrolls) || 15,
  };
  let pagesDone = 0, pagesFailed = 0, secDone = 0;
  const secondary = [];
  const secSeen = new Set();
  const visited = new Set();
  const progress = () => {
    const total = visited.size + secSeen.size;
    pill.update(
      options.followSecondary && secSeen.size
        ? `Abrindo páginas de imagem · ${plural(state.items.length, 'imagem encontrada', 'imagens encontradas')}`
        : `Lendo ${plural(visited.size, 'página', 'páginas')} · ${plural(state.items.length, 'imagem encontrada', 'imagens encontradas')}`,
      pagesDone + secDone, total > 1 ? total : 0);
  };
  log(`Escaneando ${inputs.length === 1 ? inputs[0] : plural(inputs.length, 'link', 'links')}`);

  try {
    const { pages, direct } = await core('expand', { inputs });
    for (const d of direct) {
      const host = new URL(d.url).hostname.replace(/^www\./, '');
      addItem({ url: d.url, kind: d.kind, page: new URL(d.url).origin + '/', title: '', group: ensureGroup(`direct:${host}`, host) });
    }
    if (direct.length) log(`${plural(direct.length, 'URL direta gerada', 'URLs diretas geradas')} pela sequência`);

    // `root` é a página colada: paginação e páginas de imagem herdam a pasta dela.
    const pageQueue = pages.map((url) => ({ url, depth: 0, root: url }));
    // Registra as pastas na ordem em que os links foram colados (nome provisório: o site).
    for (const url of pages) ensureGroup(url, new URL(url).hostname.replace(/^www\./, ''));
    pages.forEach((url) => visited.add(url));
    progress();
    await drain(pageQueue, 3, async (job) => {
      const r = await coreWithAuth('scan-page', { url: job.url, scripts: options.scripts, render: options.render, scroll: options.scroll, maxScrolls: options.maxScrolls });
      pagesDone++;
      if (r.error) {
        pagesFailed++;
        log(`Erro em ${job.url}: ${r.error}`, 'error');
        return progress();
      }
      if (job.depth === 0) suggestGroupName(job.root, r.folderName || r.title);
      for (const img of r.images) addItem({ ...img, page: r.finalUrl, title: r.title, group: job.root });
      if (options.followSecondary) {
        for (const s of r.secondary) {
          if (secSeen.has(s.url) || secSeen.size >= options.maxSecondary) continue;
          secSeen.add(s.url);
          secondary.push({ ...s, page: r.finalUrl, title: r.title, group: job.root });
        }
      }
      if (options.paginate && job.depth + 1 < options.maxPages) {
        const next = r.next.find((url) => !visited.has(url));
        if (next) {
          visited.add(next);
          pageQueue.push({ url: next, depth: job.depth + 1, root: job.root });
        }
      }
      const via = r.rendered ? ` · navegador: ${plural(r.render.scrolls, 'rolagem', 'rolagens')}${r.render.clicks ? `, ${plural(r.render.clicks, 'clique', 'cliques')} em “carregar mais”` : ''}` : '';
      log(`${plural(r.images.length, 'imagem', 'imagens')}${r.secondary.length ? ` e ${plural(r.secondary.length, 'página de imagem', 'páginas de imagem')}` : ''} em ${r.finalUrl}${via}`, 'ok');
      if (r.renderError) log(`O navegador falhou em ${r.finalUrl}: ${r.renderError} (usada a leitura simples)`, 'warn');
      progress();
    });

    await drain(secondary, 8, async (s) => {
      const r = await coreWithAuth('resolve', { url: s.url, referer: s.page, thumb: s.thumb, render: options.render });
      secDone++;
      if (r.error) log(`Página de imagem ${s.url}: ${r.error}`, 'error');
      else if (r.best) {
        addItem({ url: r.best.url, kind: r.best.kind, via: 'hosted', page: r.finalUrl || s.url, title: s.title || r.title, thumb: s.thumb, nameHint: r.best.nameHint, alternates: r.best.alternates, w: r.best.w, h: r.best.h, group: s.group });
      }
      progress();
    });

    const upgraded = await measureAll();
    state.phase = 'done';
    const visible = visibleItems().length;
    const detail = [
      upgraded && `${plural(upgraded, 'trocada', 'trocadas')} por versão maior`,
      pagesFailed && `${plural(pagesFailed, 'página com erro', 'páginas com erro')}`,
      state.items.length > visible && `${state.items.length - visible} ocultas pelos filtros`,
    ].filter(Boolean).join(' · ');
    if (state.cancel) toast({ title: 'Escaneamento cancelado', detail: `${plural(state.items.length, 'imagem', 'imagens')} até agora`, level: 'warn' });
    else if (state.items.length) toast({ title: `${plural(visible, 'imagem pronta', 'imagens prontas')} para baixar`, detail, level: 'ok', timeout: 5000 });
    log(`Escaneamento concluído: ${plural(state.items.length, 'imagem', 'imagens')}${detail ? ` (${detail})` : ''}`, state.items.length ? 'ok' : 'warn');
  } catch (err) {
    state.phase = 'done';
    log(`Falha ao escanear: ${err.message}`, 'error');
    toast({ title: 'Não foi possível escanear', detail: err.message, level: 'error' });
  } finally {
    setBusy(false);
  }
}

// ---------- busca ----------

async function search() {
  const query = input.value.trim();
  if (!query) {
    input.focus();
    return toast({ title: 'Digite o que buscar', level: 'info', timeout: 3500 });
  }
  closeOverlays();
  resetResults();
  state.phase = 'scanning';
  state.cancel = false;
  setBusy(true);
  const providerName = $('#provider').selectedOptions[0].textContent;
  pill.start(`Buscando “${query}” no ${providerName}…`);
  log(`Busca “${query}” no ${providerName}`);
  try {
    const r = await core('search', { provider: settings.provider, query, pages: Number(settings.searchPages) || 2 });
    if (r.error) throw new Error(r.error);
    const group = ensureGroup(`search:${query}`, query);
    for (const img of r.images) addItem({ url: img.url, kind: 'search', page: img.page || img.url, title: query, thumb: img.thumb, w: img.w, h: img.h, group });
    const upgraded = await measureAll();
    state.phase = 'done';
    log(`Busca “${query}”: ${plural(r.images.length, 'resultado', 'resultados')}`, 'ok');
    toast({ title: `${plural(visibleItems().length, 'resultado', 'resultados')} para “${query}”`, detail: upgraded ? `${plural(upgraded, 'trocado', 'trocados')} por versão maior` : '', timeout: 4500 });
  } catch (err) {
    state.phase = 'done';
    log(`Falha na busca: ${err.message}`, 'error');
    toast({ title: 'A busca falhou', detail: err.message, level: 'error' });
  } finally {
    setBusy(false);
  }
}

// ---------- download ----------

const folder = () => settings.folder || state.info.defaultFolder;

async function download() {
  const queue = visibleItems().filter((i) => i.checked);
  if (!queue.length || state.busy) return;
  state.cancel = false;
  setBusy(true);
  const total = queue.length;
  const common = {
    folder: folder(),
    skipExisting: settings.skipExisting,
    template: settings.template.trim() || '{name}',
    pad: Number(settings.seqPad) || 0,
    retries: Number(settings.retries) || 0,
    validate: settings.validate,
  };
  const start = Number(settings.seqStart) || 0;
  queue.forEach((item, i) => { item.seq = start + i; item.saveState = null; renderCard(item); });
  let done = 0, saved = 0, skipped = 0, failed = 0, retried = 0, bytes = 0;
  let lastFile = null;
  const usedDirs = new Set();
  const dirOf = (file) => file.slice(0, Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/')));
  pill.start(`Baixando ${plural(total, 'arquivo', 'arquivos')}…`);
  pill.update(`Baixando para ${common.folder}`, 0, total);
  log(`Download de ${plural(total, 'arquivo', 'arquivos')} para ${common.folder}`);

  await drain(queue, Math.min(50, Math.max(1, Number(settings.concurrency) || 8)), async (item) => {
    item.saveState = 'working';
    renderCard(item);
    const subfolder = subfolderFor(item);
    try {
      const r = await core('save', { ...common, url: item.url, referer: item.page, n: item.seq, title: item.title || '', nameHint: item.nameHint, subfolder });
      if (r.attempts > 1 || r.resumed) retried++;
      if (r.file) usedDirs.add(dirOf(r.file));
      if (r.skipped) {
        skipped++;
        item.saveState = 'skipped';
        item.saveTitle = 'Já existia na pasta';
      } else {
        saved++;
        bytes += r.bytes;
        lastFile = r.file;
        item.saveState = 'saved';
        item.saveTitle = r.file;
        item.checked = false;
      }
    } catch (err) {
      failed++;
      item.saveState = 'error';
      item.saveTitle = err.message;
      log(`Falhou ${item.url}: ${err.message}`, 'error');
    } finally {
      renderCard(item);
      done++;
      pill.update(`Baixando · ${formatBytes(bytes) || '0 KB'} salvos`, done, total);
    }
  });

  // "em Imagens\Aurora polar" (uma pasta) ou "em 3 pastas dentro de Imagens".
  const dirs = [...usedDirs];
  const rootName = lastSegment(common.folder);
  const where = dirs.length === 1
    ? (dirs[0].length > common.folder.length ? `${rootName}\\${dirs[0].slice(common.folder.length).replace(/^[\\/]+/, '')}` : rootName)
    : `${dirs.length} pastas dentro de ${rootName}`;
  const summary = [
    (saved || skipped) && dirs.length && `em ${where}`,
    skipped && plural(skipped, 'já existia', 'já existiam'),
    failed && `${failed} com erro`,
    retried && `${retried} precisaram de nova tentativa`,
  ].filter(Boolean).join(' · ');
  log(`Download concluído: ${plural(saved, 'salvo', 'salvos')}${summary ? ` ${summary}` : ''}${state.cancel ? ' (cancelado)' : ''}`, failed ? 'warn' : 'ok');
  setBusy(false);
  toast({
    title: state.cancel ? 'Download cancelado' : failed && !saved ? 'Os downloads falharam' : `${plural(saved, 'arquivo salvo', 'arquivos salvos')}${bytes ? ` · ${formatBytes(bytes)}` : ''}`,
    detail: summary,
    level: failed && !saved ? 'error' : failed ? 'warn' : 'ok',
    actionLabel: saved || skipped ? 'Abrir pasta' : failed ? 'Ver erros' : undefined,
    action: saved || skipped
      ? () => (saved === 1 && lastFile ? desktop.showFile(lastFile) : desktop.openFolder(dirs.length === 1 ? dirs[0] : common.folder))
      : () => openDrawer('activity'),
    timeout: 9000,
  });
}

// ---------- autenticação ----------

function askCredentials({ origin, realm }) {
  if (state.skippedOrigins.has(origin)) return Promise.resolve(false);
  if (state.authPrompts.has(origin)) return state.authPrompts.get(origin);
  const prompt = new Promise((resolve) => {
    const dialog = $('#authDialog');
    $('#authWhere').textContent = realm ? `${origin} · “${realm}”` : origin;
    $('#authUser').value = '';
    $('#authPass').value = '';
    dialog.addEventListener('close', async () => {
      if (dialog.returnValue !== 'ok') {
        state.skippedOrigins.add(origin);
        return resolve(false);
      }
      try {
        await core('auth', { origin, username: $('#authUser').value, password: $('#authPass').value });
        resolve(true);
      } catch {
        resolve(false);
      }
    }, { once: true });
    dialog.showModal();
    $('#authUser').focus();
  }).finally(() => state.authPrompts.delete(origin));
  state.authPrompts.set(origin, prompt);
  return prompt;
}

// ---------- visualizador ----------

function openLightbox(item) {
  closePopovers();
  state.lightbox = item;
  $('#lightbox').hidden = false;
  renderLightbox();
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  state.lightbox?.el?.focus();
  state.lightbox = null;
}

function stepLightbox(delta) {
  const visible = visibleItems();
  if (!visible.length) return closeLightbox();
  const index = visible.indexOf(state.lightbox);
  state.lightbox = visible[(index + delta + visible.length) % visible.length];
  renderLightbox();
}

function renderLightbox() {
  const item = state.lightbox;
  if (!item) return;
  const img = $('#lbImg');
  img.classList.remove('loaded');
  $('#lbLoading').hidden = false;
  img.onload = () => { img.classList.add('loaded'); $('#lbLoading').hidden = true; };
  img.onerror = () => {
    $('#lbLoading').hidden = true;
    if (item.thumb && !img.dataset.fallback) {
      img.dataset.fallback = '1';
      img.src = thumbUrl(item.thumb, item.page);
    }
  };
  delete img.dataset.fallback;
  img.src = item.type === 'video' ? (item.thumb ? thumbUrl(item.thumb, item.page) : '') : thumbUrl(item.url, item.page, true);
  $('#lbTitle').textContent = displayName(item);
  const visible = visibleItems();
  const host = (() => { try { return new URL(item.page || item.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  $('#lbInfo').innerHTML = [
    item.w ? `<span><b>${item.w} × ${item.h}</b> px</span>` : '',
    item.bytes ? `<span><b>${formatBytes(item.bytes)}</b></span>` : '',
    item.upgraded ? `<span>${escapeHtml(item.betterQuality ? 'melhor qualidade (menos compressão)' : item.originalSize ? `versão maior (a página mostrava ${item.originalSize})` : 'versão maior encontrada')}</span>` : '',
    `<span>${escapeHtml(KIND_INFO[item.kind === 'video' ? item.origin : item.kind]?.label || '')}</span>`,
    host ? `<span>${escapeHtml(host)}</span>` : '',
    `<span>${visible.indexOf(item) + 1} de ${visible.length}</span>`,
  ].filter(Boolean).join('');
  $('#lbSelect').classList.toggle('on', item.checked);
  $('#lbSelect').dataset.tip = item.checked ? 'Selecionada (espaço)' : 'Selecionar (espaço)';
}

// ---------- exportar ----------

function exportItems() {
  const visible = visibleItems().filter((i) => i.type !== 'video');
  const selected = visible.filter((i) => i.checked);
  return selected.length ? selected : visible;
}

function renderExport() {
  const items = exportItems();
  const format = $('#exportFormat button[aria-selected="true"]').dataset.value;
  $('#exportText').value = items.map((i) => {
    const thumb = i.thumb || i.url;
    return format === 'bbcode' ? `[url=${i.url}][img]${thumb}[/img][/url]` : `<a href="${escapeHtml(i.url)}"><img src="${escapeHtml(thumb)}" alt=""></a>`;
  }).join('\n');
  $('#exportInfo').textContent = `${plural(items.length, 'imagem', 'imagens')} · miniatura com link para o tamanho cheio`;
}

// ---------- painéis e popovers ----------

function closePopovers() {
  for (const pop of $$('.popover')) pop.hidden = true;
}

function openDrawer(name) {
  closePopovers();
  for (const drawer of $$('.drawer')) drawer.hidden = drawer.id !== name;
  $('#scrim').hidden = false;
  $('#btnSettings').classList.toggle('active', name === 'settings');
  $('#btnActivity').classList.toggle('active', name === 'activity');
  if (name === 'activity') $('#activityDot').hidden = true;
  if (name === 'settings') {
    requestAnimationFrame(() => positionThumb($('#renderMode')));
    refreshBrowserStatus();
  }
}

function closeDrawers() {
  for (const drawer of $$('.drawer')) drawer.hidden = true;
  $('#scrim').hidden = true;
  $('#btnSettings').classList.remove('active');
  $('#btnActivity').classList.remove('active');
}

function closeOverlays() {
  closePopovers();
  closeDrawers();
}

function setupPopover(buttonId, popId) {
  $(buttonId).addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $(popId);
    const wasHidden = pop.hidden;
    closePopovers();
    pop.hidden = !wasHidden;
  });
}

// ---------- configurações (painel) ----------

function bindSettings() {
  for (const el of $$('[data-setting]')) {
    const key = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else el.value = settings[key];
    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
      settings[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
      saveSettings();
      if (key === 'concurrency') renderRange(el);
      if (key === 'template') renderTemplatePreview();
      if (key === 'subfolder') renderDest();
    });
    if (el.type === 'range') renderRange(el);
  }
  $('[data-setting="template"]').addEventListener('input', (e) => { settings.template = e.target.value; saveSettings(); renderTemplatePreview(); });
  for (const token of $$('#tokens .token')) {
    token.addEventListener('click', () => {
      const field = $('[data-setting="template"]');
      const pos = field.selectionStart ?? field.value.length;
      field.value = field.value.slice(0, pos) + token.dataset.token + field.value.slice(field.selectionEnd ?? pos);
      field.focus();
      field.selectionStart = field.selectionEnd = pos + token.dataset.token.length;
      settings.template = field.value;
      saveSettings();
      renderTemplatePreview();
    });
  }
  setSegment($('#renderMode'), settings.render);
  for (const button of $$('#renderMode button')) {
    button.addEventListener('click', () => {
      settings.render = button.dataset.value;
      saveSettings();
      setSegment($('#renderMode'), settings.render);
    });
  }
  renderTemplatePreview();
}

function renderRange(el) {
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  el.style.setProperty('--fill', `${((Number(el.value) - min) / (max - min)) * 100}%`);
  $('#concurrencyOut').textContent = el.value;
}

function renderTemplatePreview() {
  const n = String(Number(settings.seqStart) || 1).padStart(Number(settings.seqPad) || 0, '0');
  const name = (settings.template || '{name}')
    .replace(/\{name\}/g, 'aurora-boreal')
    .replace(/\{n\}/g, n)
    .replace(/\{title\}/g, 'Galeria de Fotos')
    .replace(/\{host\}/g, 'exemplo.com');
  $('#templatePreview').textContent = `Exemplo: ${name}.jpg`;
}

const lastSegment = (path) => path.split(/[\\/]/).filter(Boolean).pop() || path;

// Grupos que têm imagens selecionadas e visíveis (os que realmente viram pastas no próximo download).
function groupCounts() {
  const counts = new Map();
  for (const item of visibleItems()) {
    if (item.checked && item.group) counts.set(item.group, (counts.get(item.group) || 0) + 1);
  }
  return counts;
}

// Botão de destino (“Imagens / Aurora polar”) e o menu com as pastas sugeridas.
function renderDest() {
  const root = folder();
  $('#folderPath').textContent = root;
  $('#folderPath').title = root;
  $('#destRoot').textContent = lastSegment(root);
  $('#destRootPath').textContent = root;
  $('#destRootPath').title = root;
  const counts = groupCounts();
  const active = [...state.groups.values()].filter((g) => counts.has(g.key));
  let sub = '';
  if (settings.subfolder === 'title') sub = active.length === 1 ? active[0].name : active.length ? `${active.length} pastas` : '';
  if (settings.subfolder === 'host') sub = 'por site';
  $('#destSub').textContent = sub;
  $('#destMain').title = `Salvar em ${root}${sub && settings.subfolder === 'title' && active.length === 1 ? `\\${sub}` : ''}`;
  if (!$('#popDest').hidden) renderDestPopover();
}

function renderDestPopover() {
  setSegment($('#subfolderMode'), settings.subfolder);
  const list = $('#destGroups');
  const counts = groupCounts();
  const editing = list.contains(document.activeElement);
  if (settings.subfolder === 'title' && !editing) {
    const withItems = new Set(state.items.map((i) => i.group));
    list.innerHTML = [...state.groups.values()].filter((g) => withItems.has(g.key)).map((g) => `
      <div class="group-row" data-key="${escapeHtml(g.key)}">
        ${icon('folder')}
        <input type="text" value="${escapeHtml(g.name)}" spellcheck="false" aria-label="Nome da pasta">
        <span class="group-count">${counts.get(g.key) ? plural(counts.get(g.key), 'imagem', 'imagens') : 'nenhuma selecionada'}</span>
        <button class="icon-btn group-reset" data-tip="Voltar ao nome sugerido" aria-label="Voltar ao nome sugerido" ${g.name === g.suggested ? 'hidden' : ''}>${icon('undo')}</button>
      </div>`).join('');
    for (const row of $$('.group-row', list)) {
      const group = state.groups.get(row.dataset.key);
      const field = $('input', row);
      const reset = $('.group-reset', row);
      field.addEventListener('input', () => {
        group.name = field.value.trim() || group.suggested;
        reset.hidden = group.name === group.suggested;
        renderDest();
      });
      field.addEventListener('blur', () => { if (!field.value.trim()) field.value = group.suggested; });
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') field.blur(); });
      reset.addEventListener('click', () => {
        group.name = group.suggested;
        field.value = group.name;
        reset.hidden = true;
        renderDest();
      });
    }
  } else if (settings.subfolder !== 'title') {
    list.replaceChildren();
  } else {
    for (const row of $$('.group-row', list)) {
      const n = counts.get(row.dataset.key);
      $('.group-count', row).textContent = n ? plural(n, 'imagem', 'imagens') : 'nenhuma selecionada';
    }
  }
  $('#destHint').textContent = {
    title: state.groups.size
      ? 'Cada página ganha uma subpasta dentro da pasta raiz. Clique num nome para editar.'
      : 'Ao escanear, cada página ganha uma subpasta com o título dela, dentro da pasta raiz.',
    host: 'Uma subpasta para cada site (ex.: unsplash.com), dentro da pasta raiz.',
    none: 'Tudo é salvo direto na pasta raiz.',
  }[settings.subfolder] || '';
}

function setSubfolderMode(mode) {
  settings.subfolder = mode;
  saveSettings();
  $('[data-setting="subfolder"]').value = mode;
  renderDest();
  renderDestPopover();
}

async function pickFolder() {
  const chosen = await desktop.pickFolder(folder());
  if (!chosen) return;
  settings.folder = chosen;
  saveSettings();
  renderDest();
  toast({ title: 'Pasta raiz alterada', detail: chosen, level: 'info', timeout: 3500 });
}

async function refreshBrowserStatus() {
  const el = $('#browserStatus');
  try {
    const r = await core('browser');
    const names = { msedge: 'Microsoft Edge', chrome: 'Google Chrome', chromium: 'Chromium' };
    el.textContent = r.available
      ? `Usa o ${names[r.channel] || r.channel} instalado para abrir galerias montadas em JavaScript, com rolagem infinita ou que bloqueiam programas.`
      : `Indisponível: ${r.error}. As páginas serão lidas só no modo simples.`;
  } catch (err) {
    el.textContent = `Não foi possível verificar: ${err.message}`;
  }
}

// ---------- eventos ----------

function bindEvents() {
  for (const button of $$('#modeSwitch button')) button.addEventListener('click', () => { setMode(button.dataset.mode); input.focus(); });
  input.addEventListener('input', () => { autoGrow(); if (!input.value.trim()) suggestClipboard(); else renderHint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  $('#go').addEventListener('click', submit);
  $('#provider').value = settings.provider;
  $('#searchPages').value = settings.searchPages;
  $('#provider').addEventListener('change', (e) => { settings.provider = e.target.value; saveSettings(); });
  $('#searchPages').addEventListener('change', (e) => { settings.searchPages = e.target.value; saveSettings(); });

  setupPopover('#chipSize', '#popSize');
  setupPopover('#chipType', '#popType');
  setupPopover('#chipSource', '#popSource');
  setupPopover('#btnMore', '#popMore');
  $('#destMain').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('#popDest');
    const wasHidden = pop.hidden;
    closePopovers();
    pop.hidden = !wasHidden;
    if (!pop.hidden) renderDestPopover();
  });
  for (const button of $$('#subfolderMode button')) button.addEventListener('click', () => setSubfolderMode(button.dataset.value));
  for (const pop of $$('.popover')) pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closePopovers);

  for (const button of $$('#popMore [data-action]')) {
    button.addEventListener('click', async () => {
      closePopovers();
      const action = button.dataset.action;
      if (action === 'select-all') setSelection(() => true);
      if (action === 'select-none') setSelection(() => false);
      if (action === 'select-invert') setSelection((i) => !i.checked);
      if (action === 'copy-links') {
        const links = visibleItems().filter((i) => i.checked).map((i) => i.url);
        await desktop.copyText(links.join('\n'));
        toast({ title: `${plural(links.length, 'link copiado', 'links copiados')}`, level: 'info', timeout: 3000 });
      }
      if (action === 'export') {
        renderExport();
        $('#exportDialog').showModal();
        requestAnimationFrame(() => positionThumb($('#exportFormat')));
      }
      if (action === 'clear') {
        resetResults();
        state.phase = 'welcome';
        refreshSummary();
      }
    });
  }

  for (const button of $$('#density button')) {
    button.addEventListener('click', () => {
      settings.density = button.dataset.density;
      saveSettings();
      setSegment($('#density'), settings.density, 'density');
      $('#gallery').dataset.density = settings.density;
    });
  }

  $('#download').addEventListener('click', download);
  $('#destPick').addEventListener('click', pickFolder);
  $('#folderChange').addEventListener('click', pickFolder);
  $('#destOpen').addEventListener('click', () => desktop.openFolder(folder()));
  $('#destPick').addEventListener('click', () => closePopovers());
  $('#pillCancel').addEventListener('click', () => {
    state.cancel = true;
    pill.update('Cancelando depois das tarefas em andamento…');
  });

  $('#btnSettings').addEventListener('click', () => ($('#settings').hidden ? openDrawer('settings') : closeDrawers()));
  $('#btnActivity').addEventListener('click', () => ($('#activity').hidden ? openDrawer('activity') : closeDrawers()));
  $('#scrim').addEventListener('click', closeDrawers);
  for (const button of $$('[data-close]')) button.addEventListener('click', closeDrawers);
  $('#activityClear').addEventListener('click', () => {
    state.log = [];
    $('#log').replaceChildren();
    $('#logEmpty').hidden = false;
  });

  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lbPrev').addEventListener('click', () => stepLightbox(-1));
  $('#lbNext').addEventListener('click', () => stepLightbox(1));
  $('#lbSelect').addEventListener('click', () => { toggleItem(state.lightbox); renderLightbox(); });
  $('#lbCopy').addEventListener('click', async () => {
    await desktop.copyText(state.lightbox.url);
    toast({ title: 'Link copiado', level: 'info', timeout: 2500 });
  });
  $('#lbSource').addEventListener('click', () => desktop.openExternal(state.lightbox.page || state.lightbox.url));
  $('.lb-stage').addEventListener('click', (e) => { if (e.target.classList.contains('lb-stage')) closeLightbox(); });

  for (const button of $$('#exportFormat button')) {
    button.addEventListener('click', () => { setSegment($('#exportFormat'), button.dataset.value); renderExport(); });
  }
  $('#exportCopy').addEventListener('click', async () => {
    await desktop.copyText($('#exportText').value);
    $('#exportCopy').innerHTML = `${icon('check')}Copiado`;
    setTimeout(() => { $('#exportCopy').innerHTML = `${icon('copy')}Copiar`; }, 1600);
  });

  // Arrastar um link para a janela.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].some((t) => t === 'text/uri-list' || t === 'text/plain')) return;
    dragDepth++;
    $('#dropOverlay').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropOverlay').hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropOverlay').hidden = true;
    const text = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n').filter((l) => /^https?:/i.test(l.trim())).join('\n');
    if (!text) return toast({ title: 'Solte um link da web (http ou https)', level: 'info', timeout: 3000 });
    setMode('pages');
    input.value = text.trim();
    autoGrow();
    scan();
  });

  window.addEventListener('focus', suggestClipboard);
  window.addEventListener('resize', () => {
    for (const seg of $$('.segmented')) positionThumb(seg);
  });

  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input, textarea, select');
    if (!$('#lightbox').hidden) {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') stepLightbox(-1);
      if (e.key === 'ArrowRight') stepLightbox(1);
      if (e.key === ' ') { e.preventDefault(); toggleItem(state.lightbox); renderLightbox(); }
      return;
    }
    if (e.key === 'Escape') {
      if ($$('.popover').some((p) => !p.hidden)) return closePopovers();
      if (!$('#scrim').hidden) return closeDrawers();
      if (state.busy) { state.cancel = true; pill.update('Cancelando depois das tarefas em andamento…'); }
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); input.focus(); input.select(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'a' && !typing && state.items.length) { e.preventDefault(); setSelection(() => true); }
    if (e.ctrlKey && e.key.toLowerCase() === 's' && !typing) { e.preventDefault(); download(); }
  });
}

// ---------- início ----------

async function init() {
  if (new URLSearchParams(location.search).get('mica') === '1') document.documentElement.classList.add('mica');
  hydrateIcons();
  state.info = await desktop.info();
  $('#versionInfo').textContent = `Baixador de Imagens ${state.info.version}`;
  buildFilterPopovers();
  bindSettings();
  bindEvents();
  renderDest();
  $('#gallery').dataset.density = settings.density;
  setSegment($('#density'), settings.density, 'density');
  setSegment($('#exportFormat'), 'html');
  setMode(settings.mode);
  refreshSummary();
  requestAnimationFrame(() => {
    for (const seg of $$('.segmented')) positionThumb(seg);
  });
  input.focus();
  suggestClipboard();
}

init();
