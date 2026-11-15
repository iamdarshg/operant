import { writeFileSync } from "node:fs";
const q = "Ubuntu 24.04 LTS release date";
const res = await fetch("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q), {
  headers: {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml",
    "accept-language": "en-US,en;q=0.9",
  },
  signal: AbortSignal.timeout(20000),
});
const text = await res.text();
console.log(JSON.stringify({ status: res.status, bytes: text.length, hasLink: text.includes("result-link"), hasUddg: text.includes("uddg=") }));
writeFileSync("D:\\CodeProjects\\operant\\packages\\web-search-ddg\\test\\lite-probe.html", text);
