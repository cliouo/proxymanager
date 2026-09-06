/** Return only a normalized same-origin path, including its query and fragment. */
export function safeNext(raw: string | null | undefined, origin: string): string {
  if (!raw || !raw.startsWith('/') || /[\\\u0000-\u0020\u007f]/u.test(raw)) return '/';
  try {
    let decoded = raw;
    for (let i = 0; i < 4; i++) {
      if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/u.test(decoded)) return '/';
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    const url = new URL(raw, origin);
    if (url.origin !== new URL(origin).origin) return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}
