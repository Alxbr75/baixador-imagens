// Gera build/icon.ico (16–256 px) e build/icon.png (512 px) a partir de build/icon.svg usando o Edge instalado.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const SIZES = [256, 128, 64, 48, 40, 32, 24, 20, 16];

async function main() {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (size) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };
  fs.writeFileSync(path.join(__dirname, 'icon.png'), await render(512));
  const images = [];
  for (const size of SIZES) images.push({ size, data: await render(size) });
  await browser.close();

  // ICO com imagens PNG embutidas (suportado desde o Windows Vista).
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
  console.log(`icon.ico: ${images.length} tamanhos (${SIZES.join(', ')} px)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
