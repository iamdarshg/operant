const puppeteer = require('puppeteer-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
(async () => {
  const url = process.argv[2] || 'http://127.0.0.1:3100/';
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 500));
  // focus the 3rd tabbable (a nav link) via keyboard
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const out = await page.evaluate(() => {
    const el = document.activeElement;
    const cs = getComputedStyle(el);
    const rules = [];
    for (const sheet of document.styleSheets) {
      let list;
      try { list = sheet.cssRules; } catch { continue; }
      for (const r of list) {
        if (r.selectorText && /focus|outline/i.test(r.selectorText + r.style?.cssText)) {
          rules.push({ sel: r.selectorText, css: r.style.cssText.slice(0, 160), matches: el.matches?.(r.selectorText) ?? false });
        }
      }
    }
    return {
      tag: el.tagName,
      text: (el.textContent || '').trim(),
      focusVisible: el.matches(':focus-visible'),
      focus: el.matches(':focus'),
      outline: { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, offset: cs.outlineOffset },
      sheets: [...document.styleSheets].map((s) => s.href || 'inline'),
      rules: rules.filter((r) => r.matches || /focus-visible/.test(r.sel)),
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();