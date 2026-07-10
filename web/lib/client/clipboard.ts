/**
 * Clipboard write with proper failure handling (P3-31). `navigator.clipboard`
 * rejects on insecure origins, when the document isn't focused, or when the
 * permission is denied — several call sites used to `await` it bare, so a
 * failure silently did nothing (or threw into an unhandled rejection) while the
 * UI still flashed "已复制". Returns whether the copy succeeded so callers can
 * show an accurate result.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  // Legacy fallback for insecure origins / older browsers.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
