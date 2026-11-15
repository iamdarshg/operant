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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

const GETTABLE: RegExp[] = [
  /^health$/,
  /^tasks$/,
  new RegExp(`^tasks/${ID}$`),
  new RegExp(`^jobs/${ID}$`),
  new RegExp(`^jobs/${ID}/events$`),
  new RegExp(`^jobs/${ID}/stream$`),
  /^memory\/search$/,
  /^agents$/,
  /^approvals$/,
  /^usage$/,
];

const POSTABLE: RegExp[] = [
  /^requests$/,
  /^memory$/,
  new RegExp(`^tasks/${ID}/cancel$`),
  new RegExp(`^approvals/${ID}/decide$`),
];

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function forward(req: NextRequest, segments: string[], method: 'GET' | 'POST'): Promise<Response> {
  const key = segments.join('/');
  const table = method === 'GET' ? GETTABLE : POSTABLE;
  if (!table.some((re) => re.test(key))) {
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
    headers['content-type'] = 'application/json';
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