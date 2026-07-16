import { describe, expect, it } from 'vitest';
import { createPinnedLookup, resolvePublicHost, safeFetchText } from '@/lib/net/safeFetch';

// These targets are rejected by validation BEFORE any network call (IP literal,
// localhost, or bad protocol), so the test never hits the network.
describe('safeFetchText SSRF guard', () => {
  const blocked = [
    'http://localhost/x',
    'http://127.0.0.1/x',
    'http://0.0.0.0/x',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://10.0.0.5/x',
    'http://192.168.1.1/x',
    'http://172.16.0.1/x',
    'http://100.64.0.1/x', // CGNAT
    'http://[::1]/x',
    'http://[fd00::1]/x', // ULA
    'http://[::ffff:7f00:1]/x', // hex IPv4-mapped loopback
    'http://[::ffff:a00:1]/x', // hex IPv4-mapped 10.0.0.1
    'http://service.internal/x',
    'http://box.local/x',
  ];
  for (const url of blocked) {
    it(`rejects ${url}`, async () => {
      await expect(safeFetchText(url)).rejects.toThrow();
    });
  }

  it('rejects non-http(s) protocols', async () => {
    await expect(safeFetchText('ftp://example.com/x')).rejects.toThrow(/http/);
    await expect(safeFetchText('file:///etc/passwd')).rejects.toThrow();
  });

  it('rejects a malformed URL', async () => {
    await expect(safeFetchText('not a url')).rejects.toThrow(/无效 URL|http/);
  });

  it('normalises and rejects hexadecimal IPv4-mapped IPv6 literals directly', async () => {
    await expect(resolvePublicHost('[::ffff:7f00:1]')).rejects.toThrow();
    await expect(resolvePublicHost('[::ffff:a00:1]')).rejects.toThrow();
  });

  it('pins lookup to validated addresses and rejects hostname changes', async () => {
    const pinned = createPinnedLookup('public.example', [
      { address: '1.1.1.1', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    const call = (
      host: string,
      options: Record<string, unknown>,
    ): Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family?: number }> =>
      new Promise((resolve) => {
        pinned(host, options as never, (error, address, family) =>
          resolve({ error, address, family }),
        );
      });

    const all = await call('public.example', { all: true, family: 0 });
    expect(all.error).toBeNull();
    expect(all.address).toEqual([
      { address: '1.1.1.1', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);

    const v6 = await call('public.example', { all: false, family: 6 });
    expect(v6).toMatchObject({
      error: null,
      address: '2606:4700:4700::1111',
      family: 6,
    });

    const mismatch = await call('rebound.internal', { all: false, family: 4 });
    expect(mismatch.error?.code).toBe('ENOTFOUND');
  });
});
