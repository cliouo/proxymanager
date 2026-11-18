import { describe, expect, it } from 'vitest';
import {
  EMPTY_ROUTE,
  draftsToRoutes,
  formatServiceRoute,
  routeDraftError,
  routeSetError,
  routeToDraft,
} from '@/ui/features/devices/tailscale-model';

describe('Tailscale service route drafts', () => {
  it('accepts IPv4 and IPv6 literals with in-range ports', () => {
    expect(routeDraftError({ ip: '100.100.1.2', port: '443' })).toBeNull();
    expect(routeDraftError({ ip: 'fd7a:115c:a1e0::1', port: '8443' })).toBeNull();
    expect(routeDraftError({ ip: '100.100.1.2', port: '0' })).toBeNull();
    expect(routeDraftError({ ip: '100.100.1.2', port: '65535' })).toBeNull();
  });

  it('treats a wholly empty row as "not filled in yet"', () => {
    expect(routeDraftError(EMPTY_ROUTE)).toBeNull();
    expect(draftsToRoutes([EMPTY_ROUTE])).toEqual([]);
  });

  it('rejects a half-filled row instead of silently dropping it', () => {
    expect(routeDraftError({ ip: '100.100.1.2', port: '' })).toMatch(/端口/);
    expect(routeDraftError({ ip: '', port: '443' })).toMatch(/目标 IP/);
    expect(() => draftsToRoutes([{ ip: '100.100.1.2', port: '' }])).toThrow();
  });

  it('rejects hostnames, malformed addresses and out-of-range ports', () => {
    expect(routeDraftError({ ip: 'nas.lan', port: '443' })).toMatch(/IPv4 或 IPv6/);
    expect(routeDraftError({ ip: '100.100.1', port: '443' })).toMatch(/IPv4 或 IPv6/);
    expect(routeDraftError({ ip: '100.100.1.2', port: '65536' })).toMatch(/0–65535/);
    expect(routeDraftError({ ip: '100.100.1.2', port: '44.3' })).toMatch(/0–65535/);
    expect(routeDraftError({ ip: '100.100.1.2', port: '-1' })).toMatch(/0–65535/);
  });

  it('requires at least one filled route for service mode', () => {
    expect(routeSetError([EMPTY_ROUTE])).toMatch(/至少/);
    expect(routeSetError([{ ip: '100.100.1.2', port: '443' }])).toBeNull();
  });

  it('flags the same destination twice, including equivalent IPv6 spellings', () => {
    expect(
      routeSetError([
        { ip: '100.100.1.2', port: '443' },
        { ip: '100.100.1.2', port: '443' },
      ]),
    ).toMatch(/重复/);
    expect(
      routeSetError([
        { ip: '2001:DB8::1', port: '443' },
        { ip: '2001:db8:0:0:0:0:0:1', port: '443' },
      ]),
    ).toMatch(/重复/);
    expect(
      routeSetError([
        { ip: '100.100.1.2', port: '443' },
        { ip: '100.100.1.2', port: '8443' },
      ]),
    ).toBeNull();
  });

  it('round-trips a stored route and formats both address families', () => {
    expect(routeToDraft({ ip: '100.100.1.2', port: 443 })).toEqual({
      ip: '100.100.1.2',
      port: '443',
    });
    expect(formatServiceRoute({ ip: '100.100.1.2', port: 443 })).toBe('100.100.1.2:443');
    expect(formatServiceRoute({ ip: 'fd7a:115c:a1e0::1', port: 443 })).toBe(
      '[fd7a:115c:a1e0::1]:443',
    );
  });
});
