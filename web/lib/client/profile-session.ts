/** A tab owns its editing scope. Cookies are only a startup preference. */
let session: { id: string | null; confirmed: boolean } | null = null;
let settle: (() => void) | null = null;
let ready: Promise<void> | null = null;

export function startProfileSession(): void {
  session = { id: null, confirmed: false };
  ready = new Promise<void>((resolve) => {
    settle = resolve;
  });
}

export function bindProfileSession(id: string | null, confirmed: boolean): void {
  session = { id, confirmed };
  if (id || !confirmed) {
    settle?.();
    settle = null;
  }
}

export function getProfileSessionId(): string {
  if (!session?.id || !session.confirmed) throw new Error('尚未确认编辑的配置文件，请重试读取。');
  return session.id;
}

const SCOPED =
  /^\/api\/v1\/(?:base|anchors|policies|rules|proxy-groups|ops|scenarios|resolved-snapshot|rule-sets|meta|preview|assistant\/(?:tool|naming-analysis))(?:\/|$)/;

export async function scopeRequest(
  path: string,
  method = 'GET',
  explicitId?: string,
): Promise<string> {
  const url = new URL(path, 'http://profile.local');
  if (!SCOPED.test(url.pathname)) {
    if (
      session &&
      !session.confirmed &&
      /^\/api\/v1\/profiles\//.test(url.pathname) &&
      !['GET', 'HEAD'].includes(method.toUpperCase())
    )
      throw new Error('配置状态尚未确认，请重试读取。');
    return path;
  }
  // Capture the initiating tab scope before awaiting any asynchronous work.
  let captured = session;
  if (captured && !captured.id && ready) {
    await ready;
    captured = session;
  }
  const id = explicitId ?? captured?.id;
  if (captured && !captured.confirmed && !['GET', 'HEAD'].includes(method.toUpperCase())) {
    throw new Error('配置文件状态尚未确认，草稿已保留，请重试读取后保存。');
  }
  if (!id) {
    if (captured) throw new Error('没有已确认的配置文件，请重新选择。');
    return path; // non-workspace clients retain their explicit legacy contract
  }
  if (!url.searchParams.has('profile') && !url.searchParams.has('profileId'))
    url.searchParams.set('profileId', id);
  return url.pathname + url.search + url.hash;
}
