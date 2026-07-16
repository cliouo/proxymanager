import { describe, expect, it } from 'vitest';
import { ipLiteralFamily } from '@/lib/net/ipLiteral';

describe('ipLiteralFamily', () => {
  it.each([
    ['0.0.0.0', 4],
    ['192.0.2.1', 4],
    ['::', 6],
    ['::1', 6],
    ['2001:db8::1', 6],
    ['::ffff:192.0.2.1', 6],
    ['::192.0.2.1', 6],
    ['1:2:3:4:5::192.0.2.1', 6],
    ['1:2:3:4:5:6:192.0.2.1', 6],
    ['2001:db8:0:1:2:3:4:5', 6],
  ] as const)('recognizes %s', (value, family) => {
    expect(ipLiteralFamily(value)).toBe(family);
  });

  it.each([
    '127.1',
    '0177.0.0.1',
    '256.0.0.1',
    '1.2.3.04',
    '2001:db8:',
    '2001::db8::1',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    'fe80::1%en0',
    '::ffff:999.0.0.1',
    '1.2.3.4::',
  ])('rejects non-canonical or malformed %s', (value) => {
    expect(ipLiteralFamily(value)).toBe(0);
  });
});
