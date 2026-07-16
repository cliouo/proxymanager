/** Browser/server-shared strict IP literal parser. It intentionally rejects
 * legacy numeric/octal IPv4 spellings and scoped IPv6 addresses that Go's
 * netip.ParseAddr would not accept for portable config fields. */
export function ipLiteralFamily(value: string): 0 | 4 | 6 {
  if (isStrictIpv4(value)) return 4;
  if (isStrictIpv6(value)) return 6;
  return 0;
}

function isStrictIpv4(value: string): boolean {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every(
      (part) => /^(?:0|[1-9]\d{0,2})$/u.test(part) && Number(part) >= 0 && Number(part) <= 255,
    )
  );
}

function isStrictIpv6(value: string): boolean {
  if (value === '' || value.includes('%') || /[^0-9A-Fa-f:.]/u.test(value)) return false;
  const halves = value.split('::');
  if (halves.length > 2) return false;
  const compressed = halves.length === 2;
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right = !compressed || halves[1] === '' ? [] : halves[1].split(':');
  if (left.some((part) => part === '') || right.some((part) => part === '')) return false;
  // Go netip only permits an embedded dotted IPv4 literal at the end of the
  // address. With `::`, a dotted part in the left half is necessarily followed
  // by compressed IPv6 units, so spellings such as `1.2.3.4::` are invalid.
  if (compressed && left.some((part) => part.includes('.'))) return false;

  const all = [...left, ...right];
  let units = 0;
  for (let index = 0; index < all.length; index += 1) {
    const part = all[index];
    if (part.includes('.')) {
      if (index !== all.length - 1 || !isStrictIpv4(part)) return false;
      units += 2;
    } else {
      if (!/^[0-9A-Fa-f]{1,4}$/u.test(part)) return false;
      units += 1;
    }
  }
  return compressed ? units < 8 : units === 8;
}
