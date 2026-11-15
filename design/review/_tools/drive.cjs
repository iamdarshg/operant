/**
 * QA review driver (temporary tool, deleted at the end of the review).
 * usage:
 *   node drive.cjs inspect <url> <out.json>
 *   node drive.cjs tab <url> <out.json>
 *   node drive.cjs contrast <url> <out.json>
 *   node drive.cjs dispatch <url> <text> <out.json>
 *   node drive.cjs tape <url> <seconds> <out.json>
 *   node drive.cjs cancel <url> <out.json>
 *   node drive.cjs approve <url> <out.json>
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function launch(width = 1440, height = 900) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  const requests = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('/api/v1/')) requests.push({ url: u.replace(/^https?:\/\/[^/]+/, ''), status: r.status(), method: r.request().method() });
  });
  return { browser, page, consoleErrors, requests };
}

const CTRL = 'a, button, input, select, textarea, summary, [tabindex], [role="button"], [role="link"], [role="switch"], [role="checkbox"]';

async function inspect(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 500));
  return page.evaluate((CTRL) => {
    const nameOf = (el) => {
      const al = el.getAttribute('aria-label');
      if (al) return al.trim();
      const lb = el.getAttribute('aria-labelledby');
      if (lb) return lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
      if (el.labels && el.labels.length) return [...el.labels].map((l) => l.textContent.trim()).join(' ').trim();
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (t) return t.slice(0, 80);
      return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
    };
    const controls = [...document.querySelectorAll(CTRL)].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        role: el.getAttribute('role') || null,
        name: nameOf(el),
        href: el.getAttribute('href') || null,
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        required: el.required === true,
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        visible: r.width > 0 && r.height > 0,
        tabIndex: el.tabIndex,
      };
    });
    const landmarks = [...document.querySelectorAll('header, nav, main, footer, aside, section[aria-labelledby], [role]')].map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      label: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || null,
      id: el.id || null,
    }));
    const skip = document.querySelector('a.skip-link');
    const skipBox = skip?.getBoundingClientRect();
    return {
      url: location.pathname + location.search,
      title: document.title,
      lang: document.documentElement.lang,
      h1: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim()),
      skipLink: skip
        ? {
            text: skip.textContent.trim(),
            href: skip.getAttribute('href'),
            targetExists: !!document.getElementById((skip.getAttribute('href') || '').slice(1)),
            box: skipBox && { x: Math.round(skipBox.x), y: Math.round(skipBox.y), w: Math.round(skipBox.width), h: Math.round(skipBox.height) },
            focusStyle: (() => {
              skip.focus();
              const cs = getComputedStyle(skip);
              return { outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, clip: cs.clipPath, top: cs.top, left: cs.left, position: cs.position };
            })(),
          }
        : null,
      ariaCurrent: [...document.querySelectorAll('[aria-current]')].map((el) => ({ el: el.tagName + ':' + el.textContent.trim(), v: el.getAttribute('aria-current') })),
      liveRegions: [...document.querySelectorAll('[aria-live],[role=log],[role=status],[role=alert]')].map((el) => ({
        role: el.getAttribute('role'),
        live: el.getAttribute('aria-live'),
        text: (el.textContent || '').trim().slice(0, 60),
      })),
      landmarks,
      controls,
      overflow: { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth },
      bodyText: document.body.innerText.slice(0, 400),
    };
  }, CTRL);
}

async function tabWalk(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 400));
  const steps = [];
  await page.evaluate(() => window.scrollTo(0, 0));
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press('Tab');
    const step = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { tag: 'BODY', name: '(body)', outline: null, ringVisible: false };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const name =
        el.getAttribute('aria-label') ||
        (el.labels && el.labels.length ? [...el.labels].map((l) => l.textContent.trim()).join(' ') : '') ||
        (el.textContent || '').trim().slice(0, 60) ||
        el.getAttribute('placeholder') ||
        el.tagName;
      return {
        tag: el.tagName.toLowerCase(),
        name: String(name).replace(/\s+/g, ' '),
        href: el.getAttribute('href'),
        outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
        boxShadow: cs.boxShadow,
        visibleRing: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        inViewport: r.y >= 0 && r.y < window.innerHeight,
        scrollY: Math.round(window.scrollY),
      };
    });
    steps.push({ i, ...step });
    if (step.tag === 'BODY') break;
  }
  return steps;
}

const CONTRAST_FN = () => {
  // Chrome keeps authored colour spaces (oklch(...)), so normalise through a
  // 2d canvas fillStyle, which resolves any CSS colour to #rrggbb.
  const cv = document.createElement('canvas').getContext('2d');
  const oklabToRgb = (L, a, b) => {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    const lin = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    const enc = (v) => {
      const c = Math.max(0, Math.min(1, v));
      return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
    };
    return { r: enc(lin[0]), g: enc(lin[1]), b: enc(lin[2]), a: 1 };
  };
  const parse = (c) => {
    if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return { r: 0, g: 0, b: 0, a: 0 };
    const num = c.match(/-?[\d.]+(?:e-?\d+)?/g)?.map(Number) ?? [];
    if (c.startsWith('oklch')) {
      const [L, C, h, alpha] = num;
      const rad = ((h || 0) * Math.PI) / 180;
      const rgb = oklabToRgb(L, C * Math.cos(rad), C * Math.sin(rad));
      return { ...rgb, a: alpha === undefined ? 1 : alpha };
    }
    if (c.startsWith('oklab')) {
      const [L, a, b, alpha] = num;
      return { ...oklabToRgb(L, a, b), a: alpha === undefined ? 1 : alpha };
    }
    if (c.startsWith('#')) {
      const n = parseInt(c.slice(1), 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return { r: 0, g: 0, b: 0, a: 1 };
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) =>
    [r, g, b]
      .map((v) => v / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
      .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const sample = (sel, note) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, note, missing: true };
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    const bg = bgOf(el);
    const L1 = lum(fg), L2 = lum(bg);
    const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
    return {
      sel,
      note,
      text: (el.textContent || '').trim().slice(0, 50),
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      color: cs.color,
      bg: `rgb(${bg.r},${bg.g},${bg.b})`,
      ratio: Number(((hi + 0.05) / (lo + 0.05)).toFixed(2)),
    };
  };
  return [
    sample('.lead', 'page lead paragraph'),
    sample('.label', 'label / meta text (12px)'),
    sample('.app-foot__inner span', 'footer text (12px)'),
    sample('.wordmark', 'wordmark on the ink bar'),
    sample('.nav-health .state', 'nav health state chip'),
    sample('h1', 'page heading'),
    sample('.tally dd', 'tally figure'),
    sample('.tally dt', 'tally caption'),
    sample('.btn--primary', 'primary button label'),
    sample('.pending-block', 'empty/error block text'),
    sample('.feedback--error', 'inline error text'),
    sample('.table th, .board th', 'table column heading'),
  ];
};

async function contrast(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 400));
  return page.evaluate(CONTRAST_FN);
}

(async () => {
  const [mode, url, a1, a2] = process.argv.slice(2);
  const { browser, page, consoleErrors, requests } = await launch(
    Number(process.env.W || 1440),
    Number(process.env.H || 900),
  );
  let out;
  try {
    if (mode === 'inspect') out = await inspect(page, url);
    else if (mode === 'tab') out = await tabWalk(page, url);
    else if (mode === 'contrast') out = await contrast(page, url);
    else if (mode === 'dispatch') {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      const before = await page.$$eval('table.board tbody tr', (n) => n.length).catch(() => 0);
      await page.type('textarea[name="text"]', a1, { delay: 2 });
      const post = page.waitForResponse((r) => r.url().includes('/api/v1/requests'), { timeout: 30000 }).catch(() => null);
      await page.click('button[type="submit"]');
      const res = await post;
      const body = res ? await res.text().catch(() => '') : '';
      await new Promise((r) => setTimeout(r, 2500));
      out = { postStatus: res?.status(), body: body.slice(0, 500), beforeRows: before, afterRows: await page.$$eval('table.board tbody tr', (n) => n.length).catch(() => 0),
        feedback: await page.$$eval('.feedback', (n) => n.map((x) => x.textContent.trim())) .catch(() => []) };
    } else if (mode === 'tape') {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      const seconds = Number(a1 || 20);
      const samples = [];
      for (let t = 0; t <= seconds; t += 4) {
        const s = await page.evaluate(() => ({
          rows: document.querySelectorAll('.tape__log .tape__row').length,
          eventsLabel: document.querySelector('.tape__head .tape__id:last-of-type')?.textContent ?? null,
          foot: document.querySelector('.tape__foot span')?.textContent ?? null,
          status: document.querySelector('.tape__ident .status, .tape__ident [class*="state"]')?.textContent ?? null,
          lastRow: [...document.querySelectorAll('.tape__log .tape__row')].slice(-1).map((r) => r.textContent.trim().slice(0, 120))[0] ?? null,
        }));
        samples.push({ t, ...s });
        if (t < seconds) await new Promise((r) => setTimeout(r, 4000));
      }
      out = { samples };
    } else if (mode === 'cancel') {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      const btn = await page.$('button');
      const labels = await page.$$eval('button', (n) => n.map((b) => b.textContent.trim()));
      if (!labels.includes('Cancel task')) {
        out = { cancelButtonPresent: false, buttons: labels, body: (await page.evaluate(() => document.body.innerText)).slice(0, 500) };
      } else {
        await page.click('button');
        const step2 = await page.$$eval('.btn-row', (n) => n.map((x) => x.textContent.trim()));
        const post = page.waitForResponse((r) => r.url().includes('/cancel'), { timeout: 20000 }).catch(() => null);
        const yes = (await page.$$('button')).find(async () => false);
        const btns = await page.$$('button');
        let clicked = false;
        for (const b of btns) {
          const t = await b.evaluate((x) => x.textContent.trim());
          if (t === 'Yes, cancel it') { await b.click(); clicked = true; break; }
        }
        const res = await post;
        const body = res ? await res.text().catch(() => '') : '';
        await new Promise((r) => setTimeout(r, 1500));
        out = {
          cancelButtonPresent: true,
          clicked,
          confirmRow: step2,
          postStatus: res?.status(),
          body: body.slice(0, 400),
          feedback: await page.$$eval('.feedback', (n) => n.map((x) => x.textContent.trim())).catch(() => []),
          statusAfter: await page.evaluate(() => document.querySelector('.screen-head__aside')?.textContent?.trim() ?? null),
        };
      }
    } else if (mode === 'approve') {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      const names = await page.$$eval('button', (n) => n.map((b) => b.textContent.trim()));
      const post = page.waitForResponse((r) => r.url().includes('/decide'), { timeout: 25000 }).catch(() => null);
      const btns = await page.$$('button');
      let clicked = false;
      for (const b of btns) {
        if ((await b.evaluate((x) => x.textContent.trim())) === 'Approve') { await b.click(); clicked = true; break; }
      }
      const res = await post;
      const body = res ? await res.text().catch(() => '') : '';
      await new Promise((r) => setTimeout(r, 2000));
      out = { buttons: names, clicked, postStatus: res?.status(), body: body.slice(0, 600),
        decidedText: await page.$$eval('.approval__decided', (n) => n.map((x) => x.textContent.trim())).catch(() => []),
        bodyText: (await page.evaluate(() => document.body.innerText)).slice(0, 600) };
    }
    out = Array.isArray(out) ? { steps: out, requests, consoleErrors } : { ...out, requests, consoleErrors };
  } finally {
    await browser.close();
  }
  const target = mode === 'dispatch' || mode === 'tape' ? a2 || 'out.json' : a1 || 'out.json';
  fs.writeFileSync(target, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 1).slice(0, 3000));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});