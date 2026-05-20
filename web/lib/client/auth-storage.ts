const KEY = 'proxymanager.admin_key';

export function getAdminKey(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(KEY);
}

export function setAdminKey(value: string): void {
  window.sessionStorage.setItem(KEY, value);
}

export function clearAdminKey(): void {
  window.sessionStorage.removeItem(KEY);
}
