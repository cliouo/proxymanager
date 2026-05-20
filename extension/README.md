# ProxyManager Extension

Browser companion to [ProxyManager](../web). Collects domains from the active
tab, runs a per-region latency comparison via your local Clash/Mihomo external
controller, and writes the winning rule back to the ProxyManager backend.

## Install (development build)

```sh
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions/`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select `extension/.output/chrome-mv3/`

For hot-reload during development, run `npm run dev` instead — it produces
`.output/chrome-mv3-dev/` and rebuilds on change.

## First-time setup

1. Click the extension icon, then **Options** (top right of the popup) — or
   right-click the icon → **Options**.
2. Fill in:
   - **Backend URL**: e.g. `https://proxymanager.vercel.app`
   - **Admin key**: the `ADMIN_KEY` env var used by the backend
   - **Clash controller URL**: typically `http://localhost:9090`
   - **Clash secret**: only if you set `external-controller-secret:` in your
     Clash/Mihomo config
3. Click **Test** under both cards to verify connectivity.
4. Click **Load from backend** to fetch your proxy-groups, then check the ones
   you want compared during speedtest (typically 香港 / 日本 / 美国 / …).
5. **Save settings**.

## Daily use

1. Open a site you want to tag (e.g. `emby.media`).
2. Browse around a bit so the extension records its subdomains/CDN hosts.
3. Click the ProxyManager icon. The popup shows every distinct hostname this
   tab touched since last navigation.
4. Tick one or more domains → **Speedtest**.
5. The popup shows per-group latency. The fastest group is pre-selected and
   highlighted; click any other group to override.
6. Click **Write → 香港** (or whichever you picked). The rule lands in the
   `manual` anchor of `base.yaml` as `DOMAIN-SUFFIX,emby.media,香港`.
7. Reload your Clash client (Mihomo will fetch your subscription URL the next
   time it refreshes — interval defaults to 24h) or use Clash's UI to force a
   reload.

## How it routes around Mixed Content

The popup runs in a `chrome-extension://` context that is technically secure,
but `fetch('http://localhost:9090/…')` from a regular HTTPS page would be
blocked. The extension dodges this by doing **all** network calls (both local
Clash and the remote backend) from the background service worker, which is
not subject to page-origin mixed-content rules.

## Permissions explained

- `storage` — persisting your backend URL, keys, and candidate groups
- `tabs` — reading the active tab's URL so the popup knows which site you're on
- `webRequest` — observing requests to collect per-tab hostnames (read-only;
  we never block or modify)
- `<all_urls>` host permission — needed because the speedtest endpoint is
  user-configurable, and `webRequest` listens across origins

Nothing is sent anywhere except to (a) your configured backend and (b) your
local Clash. No telemetry.

## Build for other targets

```sh
npm run build:firefox   # Firefox MV2
npm run zip             # zip the chrome-mv3 build for distribution
```
