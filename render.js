// Renderização com navegador headless para galerias montadas em JavaScript.
// Usa o Edge (ou Chrome) já instalado no sistema por meio do playwright-core; nada de navegador extra para baixar.
'use strict';

let playwright = null;
try {
  playwright = require('playwright-core');
} catch {}

// "chromium" só funciona se alguém tiver rodado "npx playwright install chromium".
const CHANNELS = ['msedge', 'chrome', 'chromium'];
const MAX_PAGES = 2;
const IDLE_CLOSE_MS = 120_000;
const PAGE_BUDGET_MS = 90_000;
const LOAD_MORE = /^(load more|show more|more photos|more images|view more|see more|carregar mais|mostrar mais|ver mais|mais fotos|mais imagens|cargar más|ver más|mostrar más|afficher plus|voir plus|mehr laden|mehr anzeigen)\b/i;

let browserPromise = null;
let channelInUse = null;
let closeTimer = null;
let active = 0;
const waiting = [];

function getBrowser() {
  if (!playwright) return Promise.reject(new Error('playwright-core não está instalado: rode "npm install" na pasta do app'));
  clearTimeout(closeTimer);
  if (!browserPromise) {
    browserPromise = (async () => {
      for (const channel of CHANNELS) {
        try {
          const browser = await playwright.chromium.launch(channel === 'chromium' ? { headless: true } : { channel, headless: true });
          channelInUse = channel;
          browser.on('disconnected', () => {
            browserPromise = null;
          });
          return browser;
        } catch {}
      }
      throw new Error('nenhum navegador encontrado: instale o Microsoft Edge ou o Google Chrome');
    })();
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

function scheduleClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(async () => {
    if (active || !browserPromise) return;
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    await browser?.close().catch(() => {});
  }, IDLE_CLOSE_MS);
  closeTimer.unref?.();
}

async function acquire() {
  if (active < MAX_PAGES) active++;
  else await new Promise((resolve) => waiting.push(resolve)); // recebe a vaga de quem terminou
}

function release() {
  const next = waiting.shift();
  if (next) return next();
  active--;
  if (!active) scheduleClose();
}

async function status() {
  if (!playwright) return { available: false, error: 'playwright-core não está instalado: rode "npm install" na pasta do app' };
  try {
    await getBrowser();
    if (!active) scheduleClose();
    return { available: true, channel: channelInUse };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

// Clica num botão "carregar mais" visível (fora de formulários e sem navegar para outra página).
function clickLoadMore(page) {
  return page.evaluate((source) => {
    const re = new RegExp(source, 'i');
    const candidates = document.querySelectorAll('button, [role=button], a, input[type=button]');
    for (const el of candidates) {
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
      if (!re.test(text) || el.disabled || el.closest('form')) continue;
      const href = el.tagName === 'A' ? el.getAttribute('href') || '' : '';
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    }
    return false;
  }, LOAD_MORE.source);
}

/**
 * Abre a página, espera o JavaScript, rola até o fim (rolagem infinita) e clica em "carregar mais".
 * Devolve o HTML renderizado e as URLs de imagens/vídeos vistas na rede ou em respostas JSON.
 */
async function renderPage(url, options = {}) {
  const { referer, userAgent, credentials, scroll = true, maxScrolls = 15, findUrls } = options;
  await acquire();
  let context = null;
  try {
    const browser = await getBrowser();
    const origin = new URL(url).origin;
    const login = credentials?.(origin);
    context = await browser.newContext({
      userAgent,
      viewport: { width: 1366, height: 900 },
      acceptDownloads: false,
      serviceWorkers: 'block',
      httpCredentials: login ? { ...login, origin } : undefined,
    });
    const page = await context.newPage();
    const media = new Set();
    const fromData = new Set();
    const bodies = [];
    page.on('response', (res) => {
      const resUrl = res.url();
      if (!/^https?:/i.test(resUrl)) return;
      const type = (res.headers()['content-type'] || '').toLowerCase();
      if (type.startsWith('image/') || type.startsWith('video/')) media.add(resUrl);
      else if (findUrls && ['xhr', 'fetch'].includes(res.request().resourceType()) && /json|javascript|text\//.test(type)) {
        bodies.push(res.text().then((text) => {
          if (text.length < 5_000_000) for (const found of findUrls(text)) fromData.add(found);
        }).catch(() => {}));
      }
    });
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
    page.on('popup', (popup) => popup.close().catch(() => {}));

    const deadline = Date.now() + PAGE_BUDGET_MS;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000, referer });
    const httpStatus = response?.status() ?? 0;
    const authenticate = response?.headers()['www-authenticate'] || '';
    if (httpStatus === 401 && /\b(basic|digest)\b/i.test(authenticate)) return { status: 401, authenticate };
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    let scrolls = 0;
    let clicks = 0;
    if (scroll) {
      let stable = 0;
      while (scrolls < maxScrolls && Date.now() < deadline) {
        const before = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        scrolls++;
        await page.waitForTimeout(900);
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        if (clicks < 30 && (await clickLoadMore(page).catch(() => false))) {
          clicks++;
          stable = 0;
          await page.waitForTimeout(900);
          await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
          continue;
        }
        const after = await page.evaluate(() => document.documentElement.scrollHeight);
        stable = after > before ? 0 : stable + 1;
        if (stable >= 2) break;
      }
    }

    const html = await page.content();
    const finalUrl = page.url();
    await Promise.race([Promise.allSettled(bodies), new Promise((r) => setTimeout(r, 3000))]);
    return { status: httpStatus, finalUrl, html, media: [...media], fromData: [...fromData], scrolls, clicks, channel: channelInUse };
  } finally {
    await context?.close().catch(() => {});
    release();
  }
}

async function shutdown() {
  const browser = await browserPromise?.catch(() => null);
  await browser?.close().catch(() => {});
}

module.exports = { renderPage, status, shutdown, isInstalled: () => !!playwright };
