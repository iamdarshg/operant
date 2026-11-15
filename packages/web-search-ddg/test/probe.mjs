const q = "Ubuntu 24.04 LTS release date";
const body = new URLSearchParams({ q });
const t0 = Date.now();
const res = await fetch("https://html.duckduckgo.com/html/", {
  method: "POST",
  headers: {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "content-type": "application/x-www-form-urlencoded",
    accept: "text/html,application/xhtml+xml",
    "accept-language": "en-US,en;q=0.9",
  },
  body,
  signal: AbortSignal.timeout(20000),
});
const text = await res.text();
console.log(JSON.stringify({ status: res.status, ms: Date.now()-t0, bytes: text.length, hasResultA: text.includes("result__a"), hasUddg: text.includes("uddg=") }));
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2] ?? "ddg-probe.html", text);
