// Processo principal do app de desktop: janela, ponte segura com a interface e acesso ao motor (core.js).
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, nativeTheme, nativeImage, clipboard, Menu, screen } = require('electron');
const core = require('./core.js');

const IS_WIN11 = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22000;
const USE_MICA = IS_WIN11 && process.env.BID_NO_MICA !== '1';
const THUMB_WIDTH = 520;
const THUMB_CACHE_BYTES = 80 * 1024 * 1024;
const MAX_THUMB_SOURCE = 30 * 1024 * 1024;

protocol.registerSchemesAsPrivileged([
  { scheme: 'thumb', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Pasta de dados separada (usada pelos testes automatizados para não mexer nas configurações do usuário).
if (process.env.BID_USER_DATA) app.setPath('userData', process.env.BID_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('com.baixador.imagens');

let win = null;

// ---------- posição e tamanho da janela entre sessões ----------

const boundsFile = () => path.join(app.getPath('userData'), 'window.json');

function loadBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      saved.x < a.x + a.width - 100 && saved.x + saved.width > a.x + 100 && saved.y >= a.y - 20 && saved.y < a.y + a.height - 100);
    return visible ? saved : null;
  } catch {
    return null;
  }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const data = { ...win.getNormalBounds(), maximized: win.isMaximized() };
  try {
    fs.mkdirSync(path.dirname(boundsFile()), { recursive: true });
    fs.writeFileSync(boundsFile(), JSON.stringify(data));
  } catch {}
}

// ---------- miniaturas: busca com referer e reduz fotos grandes antes de mostrar ----------

const thumbCache = new Map();
let thumbCacheBytes = 0;

function cacheThumb(key, entry) {
  thumbCache.set(key, entry);
  thumbCacheBytes += entry.data.length;
  while (thumbCacheBytes > THUMB_CACHE_BYTES && thumbCache.size) {
    const [oldKey, old] = thumbCache.entries().next().value;
    thumbCache.delete(oldKey);
    thumbCacheBytes -= old.data.length;
  }
}

async function readBody(stream, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handleThumb(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get('u');
  const referer = url.searchParams.get('r');
  const full = url.searchParams.get('full') === '1';
  const key = `${full ? 'full' : 'thumb'} ${target}`;
  const cached = thumbCache.get(key);
  if (cached) return new Response(cached.data, { headers: { 'content-type': cached.type } });
  try {
    const upstream = await core.fetchThumb(target, referer);
    if (!upstream) return new Response(null, { status: 502 });
    if (full) return new Response(upstream.body, { headers: { 'content-type': upstream.type } });
    const data = await readBody(upstream.body, MAX_THUMB_SOURCE);
    if (!data) return new Response(null, { status: 413 });
    let out = { data, type: upstream.type };
    // JPEG/PNG grandes viram miniaturas leves (o Chromium não precisa decodificar fotos 4K na grade).
    if (/image\/(jpeg|png)/.test(upstream.type) && data.length > 150 * 1024) {
      const image = nativeImage.createFromBuffer(data);
      const { width } = image.getSize();
      if (width > THUMB_WIDTH) out = { data: image.resize({ width: THUMB_WIDTH, quality: 'good' }).toJPEG(84), type: 'image/jpeg' };
    }
    cacheThumb(key, out);
    return new Response(out.data, { headers: { 'content-type': out.type } });
  } catch {
    return new Response(null, { status: 502 });
  }
}

// ---------- janela ----------

function createWindow() {
  nativeTheme.themeSource = 'dark';
  const saved = loadBounds();
  win = new BrowserWindow({
    width: saved?.width || 1320,
    height: saved?.height || 860,
    x: saved?.x,
    y: saved?.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Baixador de Imagens',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    backgroundColor: USE_MICA ? '#00000000' : '#0f1116',
    ...(USE_MICA ? { backgroundMaterial: 'mica' } : {}),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#c9cedb', height: 48 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (saved?.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'app', 'index.html'), { query: { mica: USE_MICA ? '1' : '0' } });
  win.once('ready-to-show', () => win.show());
  win.on('close', saveBounds);

  // Nada navega dentro da janela: links da web abrem no navegador padrão.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });
}

// ---------- ponte com a interface ----------

ipcMain.handle('core', (_event, name, body) => core.call(String(name), body || {}));
ipcMain.handle('app-info', () => ({ defaultFolder: core.DEFAULT_FOLDER, version: app.getVersion(), mica: USE_MICA }));
ipcMain.handle('pick-folder', async (_event, current) => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Escolha onde salvar as imagens',
    defaultPath: current || core.DEFAULT_FOLDER,
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('open-folder', async (_event, dir) => {
  const target = path.isAbsolute(String(dir || '')) ? String(dir) : core.DEFAULT_FOLDER;
  await fsp.mkdir(target, { recursive: true });
  return shell.openPath(target);
});
ipcMain.handle('show-file', (_event, file) => {
  if (path.isAbsolute(String(file || ''))) shell.showItemInFolder(String(file));
});
ipcMain.handle('open-external', (_event, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
});
ipcMain.handle('copy-text', (_event, text) => clipboard.writeText(String(text ?? '')));
ipcMain.handle('read-clipboard', () => clipboard.readText().slice(0, 20_000));

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('thumb', handleThumb);
  createWindow();
});

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('window-all-closed', () => {
  core.shutdown().finally(() => app.quit());
});
