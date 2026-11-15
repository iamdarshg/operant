const puppeteer = require('puppeteer-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fs = require('fs');
(async () => {
  const url = process.argv[2] || 'http://127.0.0.1:3100/';
  const prefix = process.argv[3] || 'design/review/focus';
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 500));
  const rows = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 120));
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { tag: el.tagName, name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40), top: Math.round(r.top), outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, shadow: cs.boxShadow };
    });
    rows.push({ i, ...info });
    await page.screenshot({ path: `${prefix}-${i}.png`, clip: { x: 0, y: 0, width: 1440, height: Math.min(900, Math.max(120, info.top + 220)) } });
  }
  console.log(JSON.stringify(rows, null, 1));
  await browser.close();
})();