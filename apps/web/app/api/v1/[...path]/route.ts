/**
 * A single server-side proxy in front of the Operant control plane.
 *
 * The browser never sees the bearer token: this handler attaches it, forwards a
 * whitelisted path, and streams SSE without buffering. Paths outside the
 * documented surface are refused rather than passed through, so the proxy can
 * never become an open relay to the control plane.
 */
import type { NextRequest } from 'next/server';
import { API_BASE, controlPlaneToken } from '@/lib/api';
import { isProxied, type ProxyMethod } from '@/lib/proxy-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The allow-list lives in lib/proxy-policy.ts so it can be tested directly; it is
// a security boundary, not routing detail.

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function forward(req: NextRequest, segments: string[], method: 'GET' | 'POST' | 'DELETE'): Promise<Response> {
  const key = segments.join('/');
  if (!isProxied(method as ProxyMethod, segments)) {
    return json({ error: 'endpoint_not_proxied', path: `/v1/${key}` }, 404);
  }
  const token = controlPlaneToken();
  if (!token) return json({ error: 'server_missing_token' }, 503);

  const target = new URL(`${API_BASE}/v1/${key}`);
  req.nextUrl.searchParams.forEach((value, name) => target.searchParams.set(name, value));

  const streaming = key.endsWith('/stream');
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body: string | undefined;
  if (method === 'POST') {
    body = await req.text();
    // Only declare a JSON content-type when there IS a body. Sending
    // `content-type: application/json` with an empty body makes Fastify reject
    // the request with FST_ERR_CTP_EMPTY_JSON_BODY (400) — which is exactly why
    // "Cancel task" was dead in the UI while the same endpoint worked from curl.
    if (body.length > 0) headers['content-type'] = 'application/json';
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body,
      cache: 'no-store',
      signal: streaming ? undefined : AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return json({ error: 'control_plane_unreachable', detail: String(err) }, 502);
  }

  const type = upstream.headers.get('content-type') ?? 'application/json';
  if (type.includes('text/event-stream')) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }

  // Binary deliverables (artifacts) must pass through as bytes. Decoding every
  // response as text — as this proxy first did — silently corrupts any file that
  // is not valid UTF-8, so a download would "work" and produce a broken file.
  const textual = /^text\/|^application\/(json|xml)|javascript|^image\/svg/i.test(type);
  if (!textual) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': type,
        'content-disposition': upstream.headers.get('content-disposition') ?? 'attachment',
        'content-length': upstream.headers.get('content-length') ?? '',
        'x-content-sha256': upstream.headers.get('x-content-sha256') ?? '',
        'cache-control': 'no-store',
      },
    });
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': type, 'cache-control': 'no-store' },
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return forward(req, path, 'GET');
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return forward(req, path, 'POST');
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return forward(req, path, 'DELETE');
}
