import { defineConfig } from 'wxt';

// https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'ProxyManager',
    description:
      'Tag any domain with a per-region proxy: collect from the current tab, speedtest via local Clash, write the rule to ProxyManager.',
    permissions: ['storage', 'tabs', 'webRequest'],
    // `<all_urls>` is needed both for the webRequest listener that collects
    // hostnames per tab AND for fetching arbitrary `localhost:9090` + the
    // user-configured backend host without per-origin allowlisting at install
    // time. Trade-off accepted for personal use.
    host_permissions: ['<all_urls>', 'http://localhost/*', 'http://127.0.0.1/*'],
    action: {
      default_title: 'ProxyManager',
    },
    options_ui: {
      open_in_tab: true,
    },
  },
});
