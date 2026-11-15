const puppeteer = require('puppeteer-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fs = require('fs');

const ROUTES = (process.argv[2] || '/').split(',');
const WIDTHS = (process.argv[3] || '1440,768,390').split(',').map(Number);
const BASE = process.argv[4] || 'http://127.0.0.1:3100';
const PREFIX = process.argv[5] || 'design/review/resp';

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--font-render-hinting=none'] });
  const page = await browser.newPage();
  const report = [];
  for (const route of ROUTES) {
    for (const w of WIDTHS) {
      await page.setViewport({ width: w, height: w <= 400 ? 844 : 900, deviceScaleFactor: 1 });
      await page.goto(BASE + route, { waitUntil: 'networkidle2', timeout: 60000 });
      await page.evaluate(() => document.fonts.ready);
      await new Promise((r) => setTimeout(r, 700));
      const m = await page.evaluate(() => {
        const de = document.documentElement;
        const offenders = [];
        document.querySelectorAll('body *').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1)) {
            offenders.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 50), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) });
          }
        });
        const small = [];
        document.querySelectorAll('a, button, input, select, textarea, summary').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && (r.height < 24 || r.width < 24)) small.push({ tag: el.tagName.toLowerCase(), text: (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) });
        });
        return {
          scrollW: de.scrollWidth, clientW: de.clientWidth, overflowX: de.scrollWidth > de.clientWidth,
          offenders: offenders.slice(0, 12), smallTargets: small.slice(0, 20),
          tables: [...document.querySelectorAll('table')].map((t) => ({ cls: t.className, w: Math.round(t.getBoundingClientRect().width), scrollW: t.scrollWidth, rows: t.rows.length })),
        };
      });
      const file = `${PREFIX}${route.replace(/[^a-z0-9]/gi, '_') || 'root'}-${w}.png`;
      await page.screenshot({ path: file, fullPage: true });
      report.push({ route, w, file, ...m });
    }
  }
  fs.writeFileSync(`${PREFIX}-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.map((r) => ({ route: r.route, w: r.w, overflowX: r.overflowX, scrollW: r.scrollW, clientW: r.clientW, offenders: r.offenders.length, small: r.smallTargets.length, tables: r.tables })), null, 1));
  await browser.close();
})();