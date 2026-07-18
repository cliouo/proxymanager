import { createHash } from 'node:crypto';

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dashless "hashlike" UUID form. Fixed Mihomo parses user IDs with
 * gofrs/uuid `FromString`, which accepts this form directly, and providers do
 * emit it — so it is the same identity as its canonical spelling, not a
 * custom string to be UUIDv5-mapped (it would also exceed the 30-byte custom
 * bound and reject).
 */
const HASHLIKE_UUID_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * XTLS custom UUID mapping permits 1..30 UTF-8 bytes and maps the value through
 * UUIDv5 with the nil namespace before a share/subscription is emitted.
 */
export const MAX_MIHOMO_USER_ID_BYTES = 30;

export function isCanonicalUuid(value: string): boolean {
  return CANONICAL_UUID_PATTERN.test(value);
}

export function isValidMihomoUserId(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_MIHOMO_USER_ID_BYTES &&
    !/[\x00-\x1f\x7f-\x9f]/u.test(value)
  );
}

/** Canonical UUIDs are case-normalised; bounded custom IDs become canonical UUIDv5. */
export function normalizeMihomoUserId(value: string): string | null {
  if (isCanonicalUuid(value)) return value.toLowerCase();
  if (HASHLIKE_UUID_PATTERN.test(value)) {
    const hex = value.toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
      16,
      20,
    )}-${hex.slice(20)}`;
  }
  if (!isValidMihomoUserId(value)) return null;

  const bytes = createHash('sha1')
    .update(Buffer.alloc(16))
    .update(value, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}
