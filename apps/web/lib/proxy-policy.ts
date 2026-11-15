/**
 * Which control-plane paths the dashboard proxy will forward.
 *
 * This is a **security boundary**, not routing plumbing: the proxy attaches the
 * bearer token server-side, so any path reachable here is reachable by any
 * browser that can load the dashboard. It therefore lives in its own module with
 * its own tests, instead of being three consts buried in a route file.
 *
 * Anything not listed is refused with 404 — the proxy must never become an open
 * relay to the control plane.
 */

const ID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

const GETTABLE: RegExp[] = [
  /^health$/,
  /^tasks$/,
  new RegExp(`^tasks/${ID}$`),
  new RegExp(`^tasks/${ID}/artifacts$`),
  new RegExp(`^artifacts/${ID}/download$`),
  new RegExp(`^jobs/${ID}$`),
  new RegExp(`^jobs/${ID}/events$`),
  new RegExp(`^jobs/${ID}/stream$`),
  /^memory\/search$/,
  /^agents$/,
  /^approvals$/,
  /^schedules$/,
  /^usage$/,
];

const POSTABLE: RegExp[] = [
  /^requests$/,
  /^memory$/,
  /^schedules$/,
  new RegExp(`^tasks/${ID}/cancel$`),
  new RegExp(`^approvals/${ID}/decide$`),
];

const DELETABLE: RegExp[] = [new RegExp(`^schedules/${ID}$`)];

export type ProxyMethod = 'GET' | 'POST' | 'DELETE';

/** True only for an exact allow-listed path on an allow-listed method. */
export function isProxied(method: ProxyMethod, segments: string[]): boolean {
  const key = segments.join('/');
  const table = method === 'GET' ? GETTABLE : method === 'POST' ? POSTABLE : DELETABLE;
  return table.some((re) => re.test(key));
}