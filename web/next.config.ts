import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 锁 Turbopack 解析根到 `web/`，避免它沿着错误的 lockfile 把仓库父目录
  // 当作 monorepo workspace（曾导致 shiki 全 grammar 树被扫，dev 模式爆内存）。
  turbopack: {
    root: __dirname,
  },
  // 同上：webpack 路径解析也锁在 web/，让 production build 不会越界。
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
