/**
 * Screenshot helper for the design review pass.
 * usage: node design/shot.cjs <url> <width> <height> <out.png> [--full] [--wait=ms]
 * Requires puppeteer-core on NODE_PATH (global install is fine).
 */
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function main() {
  const [url, width, height, out] = process.argv.slice(2);
  if (!url || !width || !height || !out) {
    console.error('usage: node design/shot.cjs <url> <width> <height> <out.png> [--full] [--wait=ms]');
    process.exit(2);
  }
  const full = process.argv.includes('--full');
  const waitArg = process.argv.find((a) => a.startsWith('--wait='));
  const wait = waitArg ? Number(waitArg.slice('--wait='.length)) : 600;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: Number(width), height: Number(height), deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, wait));
  await page.screenshot({ path: out, fullPage: full });
  console.log(`wrote ${out} at ${width}x${height}${full ? ' (full page)' : ''}`);
  if (errors.length) console.log('console errors:\n' + errors.join('\n'));
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});