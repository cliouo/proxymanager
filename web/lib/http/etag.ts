import { createHash } from 'node:crypto';

/** RFC 9110-ish If-None-Match check: exact entity-tag match in the list, or `*`. */
export function etagMatches(ifNoneMatch: string, etag: string): boolean {
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .map((t) => t.trim())
    .some((t) => t === etag || t === `W/${etag}`);
}

/** Strong ETag from response body content — quoted, ready for the header. */
export function contentEtag(body: string): string {
  return `"${createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32)}"`;
}
