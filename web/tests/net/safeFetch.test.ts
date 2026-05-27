import { describe, expect, it } from 'vitest';
import { safeFetchText } from '@/lib/net/safeFetch';

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
});
