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

/**
 * Canonical spelling of an IPv4/IPv6 literal, used only for *comparison*
 * (e.g. deciding whether two Tailscale service routes point at the same
 * address). Returns '' for anything the strict parsers above reject.
 *
 * IPv4 drops leading zeros; IPv6 expands to eight numeric groups and applies
 * RFC 5952-style lowercase hex plus longest-zero-run compression, so
 * `2001:DB8:0:0:0:0:0:1` and `2001:db8::1` compare equal.
 */
export function canonicalIpLiteral(value: string): string {
  const family = ipLiteralFamily(value);
  if (family === 4) {
    return value
      .split('.')
      .map((part) => String(Number(part)))
      .join('.');
  }
  if (family !== 6) return '';

  const groupsOf = (part: string): number[] => {
    const groups: number[] = [];
    for (const unit of part === '' ? [] : part.split(':')) {
      if (unit.includes('.')) {
        const [a, b, c, d] = unit.split('.').map(Number);
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      groups.push(Number.parseInt(unit, 16));
    }
    return groups;
  };

  const compressed = value.includes('::');
  const [head = '', tail] = value.split('::');
  const left = groupsOf(head);
  const right = compressed ? groupsOf(tail ?? '') : [];
  const zeros = compressed ? Math.max(0, 8 - left.length - right.length) : 0;
  const groups = [...left, ...new Array<number>(zeros).fill(0), ...right];

  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < groups.length; ) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }

  const hex = groups.map((group) => group.toString(16));
  if (bestStart < 0) return hex.join(':');
  const before = hex.slice(0, bestStart).join(':');
  const after = hex.slice(bestStart + bestLength).join(':');
  return `${before}::${after}`;
}
