/**
 * Pure form logic for the device Tailscale card.
 *
 * The card edits two different things that must not be confused:
 *  - the **legacy** instance (CIDR mode by default, switchable to service mode),
 *  - any number of **additional** instances, which may only route exact
 *    `IP + port` services.
 *
 * Every helper here is browser-safe (no I/O) so the same rules can be unit
 * tested and reused by both editors. The server remains authoritative; these
 * functions only keep obviously-invalid input from being submitted.
 */

import { ipLiteralFamily } from '@/lib/net/ipLiteral';
import { tailscaleServiceRouteKey, type TailscaleServiceRoute } from '@/schemas';

/** One editable route row: the port is a string while the user types. */
export interface ServiceRouteDraft {
  ip: string;
  port: string;
}

export const EMPTY_ROUTE: ServiceRouteDraft = { ip: '', port: '' };

/** `host:port` for display next to a route. */
export function formatServiceRoute(route: TailscaleServiceRoute): string {
  return ipLiteralFamily(route.ip) === 6
    ? `[${route.ip}]:${route.port}`
    : `${route.ip}:${route.port}`;
}

export function routeToDraft(route: TailscaleServiceRoute): ServiceRouteDraft {
  return { ip: route.ip, port: String(route.port) };
}

/**
 * Validate one route row.
 *
 * Returns `null` when the row is empty in *both* fields (the editor treats a
 * blank trailing row as "not filled in yet"), and an error message otherwise.
 * A partially filled row is an error: silently dropping it would save a
 * different route set than the user sees.
 */
export function routeDraftError(draft: ServiceRouteDraft): string | null {
  const ip = draft.ip.trim();
  const port = draft.port.trim();
  if (ip === '' && port === '') return null;
  if (ip === '') return '请填写目标 IP';
  if (ipLiteralFamily(ip) === 0) return '目标 IP 必须是 IPv4 或 IPv6 字面量，不能写域名';
  if (port === '') return '请填写目标端口';
  if (!/^\d{1,5}$/u.test(port)) return '端口必须是 0–65535 的整数';
  const numeric = Number(port);
  if (numeric > 65_535) return '端口必须是 0–65535 的整数';
  return null;
}

/** Rows → typed routes; throws on an invalid row so a caller cannot half-save. */
export function draftsToRoutes(drafts: readonly ServiceRouteDraft[]): TailscaleServiceRoute[] {
  const routes: TailscaleServiceRoute[] = [];
  for (const draft of drafts) {
    const error = routeDraftError(draft);
    if (error) throw new Error(error);
    if (draft.ip.trim() === '' && draft.port.trim() === '') continue;
    routes.push({ ip: draft.ip.trim(), port: Number(draft.port.trim()) });
  }
  return routes;
}

/**
 * Error for a route set that is empty or repeats a destination.
 *
 * Two equivalent spellings of the same IPv6 address count as a repeat — the
 * server compares canonical spellings too, so the browser must not pretend
 * they are different.
 */
export function routeSetError(drafts: readonly ServiceRouteDraft[]): string | null {
  const filled = drafts.filter((draft) => draft.ip.trim() !== '' || draft.port.trim() !== '');
  if (filled.length === 0) return '至少配置一条「目标 IP + 端口」';
  const seen = new Set<string>();
  for (const draft of filled) {
    const error = routeDraftError(draft);
    if (error) return error;
    const key = tailscaleServiceRouteKey({ ip: draft.ip.trim(), port: Number(draft.port.trim()) });
    if (seen.has(key)) return `「${draft.ip.trim()}:${draft.port.trim()}」重复了`;
    seen.add(key);
  }
  return null;
}
