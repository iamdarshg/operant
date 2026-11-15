const puppeteer = require('puppeteer-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
(async () => {
  const url = process.argv[2] || 'http://127.0.0.1:3100/';
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 400));
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const client = await page.createCDPSession();
  await client.send('DOM.enable');
  await client.send('CSS.enable');
  const { root } = await client.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.nav-list a[aria-current="page"]' });
  const matched = await client.send('CSS.getMatchedStylesForNode', { nodeId });
  const collect = (arr, src) =>
    (arr || []).flatMap((m) =>
      (m.matchedCSSRules || []).map((r) => ({
        src,
        sel: r.rule.selectorList.text,
        origin: r.rule.origin,
        props: r.rule.style.cssProperties.filter((p) => /outline/.test(p.name)).map((p) => `${p.name}:${p.value}${p.important ? ' !important' : ''}${p.disabled ? ' (disabled)' : ''}`),
      })),
    ).filter((r) => r.props.length);
  const inline = (matched.inlineStyle?.cssProperties || []).filter((p) => /outline/.test(p.name)).map((p) => `${p.name}:${p.value}`);
  const out = {
    matched: collect(matched.matchedCSSRules, 'author'),
    inherited: collect(matched.inherited, 'inherited'),
    pseudo: collect(matched.pseudoElements, 'pseudo'),
    inline,
  };
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();