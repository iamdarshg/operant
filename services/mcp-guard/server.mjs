#!/usr/bin/env node
/**
 * Authenticating reverse proxy for VoiceStudio's MCP endpoint.
 *
 * WHY THIS EXISTS
 * VoiceStudio (ghcr.io/debpalash/voicestudio) exposes `/mcp/` with **no
 * authentication at all** — the independent security review confirmed that
 * `initialize`, `tools/list` and `tools/call` all succeed with zero credentials,
 * including `clone_voice`. Binding it to loopback helps only until something on
 * the host is compromised or a port-forward is left open, and then the machine's
 * voice becomes anyone's to impersonate.
 *
 * WHAT IT DOES
 * Terminates the MCP HTTP surface on a second loopback port and requires
 * `Authorization: Bearer $OPERANT_MCP_TOKEN` before forwarding anything to the
 * real service. It forwards method, path, headers, query and body unchanged, and
 * streams the response back without buffering, so Streamable-HTTP MCP (POST JSON
 * plus GET SSE) works as the client expects.
 *
 * It is deliberately dependency-free and small: a 300-line proxy with an auth
 * check is auditable; a framework with middleware is not.
 */
import { createServer, request as httpRequest } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const LISTEN_PORT = Number(process.env['OPERANT_MCP_PROXY_PORT'] ?? 3901);
const UPSTREAM_HOST = process.env['OPERANT_MCP_UPSTREAM_HOST'] ?? '127.0.0.1';
const UPSTREAM_PORT = Number(process.env['OPERANT_MCP_UPSTREAM_PORT'] ?? 3900);
const TOKEN = process.env['OPERANT_MCP_TOKEN'] ?? '';

if (TOKEN.length < 16) {
  // Fail closed and loudly: a proxy that starts without a token is worse than no
  // proxy, because it looks protected.
  console.error('FATAL: OPERANT_MCP_TOKEN is unset or shorter than 16 characters; refusing to start.');
  process.exit(1);
}

const expected = Buffer.from(`Bearer ${TOKEN}`, 'utf8');

function authorised(header) {
  if (typeof header !== 'string' || header.length === 0) return false;
  const given = Buffer.from(header, 'utf8');
  // Length check first: timingSafeEqual throws on unequal lengths.
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` }));
    return;
  }

  if (!authorised(req.headers.authorization)) {
    // Do not reveal whether the path exists upstream.
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.authorization; // the upstream needs no credential and should not see ours
  headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;

  const upstream = httpRequest(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream_unreachable', detail: String(err).slice(0, 200) }));
    } else {
      res.end();
    }
  });

  req.pipe(upstream);
});

// SSE connections are long-lived; the default 5-minute socket timeout would cut
// a streaming MCP session mid-flight.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.timeout = 0;

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`mcp-guard listening on 127.0.0.1:${LISTEN_PORT} → ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`mcp-guard: ${signal}, closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}