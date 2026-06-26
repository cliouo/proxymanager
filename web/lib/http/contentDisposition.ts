/**
 * Build an `attachment` Content-Disposition header value that survives non-ASCII
 * filenames (Chinese / emoji subscription names). Per RFC 6266 / RFC 5987 we
 * emit BOTH forms: a sanitised ASCII `filename=` for legacy clients and a
 * percent-encoded `filename*=UTF-8''…` carrying the real name. Modern proxy
 * clients prefer `filename*`, so that's where the user-facing name lands.
 */
export function attachmentDisposition(filename: string): string {
  // ASCII fallback — strip anything outside printable ASCII and the quote/
  // backslash that would otherwise break out of the quoted-string.
  const asciiSafe = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
