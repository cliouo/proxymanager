浏览器回归使用合成工作台数据与临时 HTTP 后端，不依赖生产 Redis、订阅源或代理控制器。

使用 Node 22，先安装 `web` 与 `extension` 的依赖，然后在 `web` 目录运行：

```sh
npx playwright install chromium
npm run test:e2e
```

配置会自动启动本地 Next.js 开发服务器。扩展用例会构建 `extension/build/chrome-mv3` 并在隔离 Chromium 会话中加载它。

验证生产产物：

```sh
npm run build
PM_E2E_PRODUCTION=1 npm run test:e2e
```

Linux 需要 Playwright 的 Chromium 系统依赖。失败时的 trace 保存在 `test-results/`，该目录不进入版本控制。
