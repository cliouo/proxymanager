'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

/**
 * 页面级 chrome 注入 —— v2 原型把页面标题区(返回链 / 标题 / pill / crumb /
 * 主操作钮)放在 topbar 里,而不是内容区顶部。页面通过 <PageTopbar> 把这一段
 * 注入共享 Topbar,同时可指定内容区 max-width(原型逐页不同:列表 1080 /
 * 详情 1280 / 默认 1240)。
 *
 * 值与 setter 拆成两个 context:注入方(PageTopbar)只订阅 setter,
 * 避免 set → 重渲染 → 再 set 的回环。
 */

export interface PageChrome {
  topbar: ReactNode;
  /** 内容区 max-width(px),覆盖 .content 默认的 1240。 */
  contentMaxWidth?: number;
}

const ChromeValueContext = createContext<PageChrome | null>(null);
const ChromeSetContext = createContext<(c: PageChrome | null) => void>(() => undefined);

export function PageChromeProvider({ children }: { children: ReactNode }) {
  const [chrome, setChrome] = useState<PageChrome | null>(null);
  return (
    <ChromeSetContext.Provider value={setChrome}>
      <ChromeValueContext.Provider value={chrome}>{children}</ChromeValueContext.Provider>
    </ChromeSetContext.Provider>
  );
}

/** Topbar / layout 侧读取当前页注入的 chrome。 */
export function usePageChrome(): PageChrome | null {
  return useContext(ChromeValueContext);
}

/**
 * 页面侧:渲染期把 children 注入 topbar(自身不输出 DOM)。
 * 无依赖数组 —— 每次渲染同步最新闭包(脏标记 / busy 等),卸载时还原默认 topbar。
 */
export function PageTopbar({
  children,
  contentMaxWidth,
}: {
  children: ReactNode;
  contentMaxWidth?: number;
}) {
  const set = useContext(ChromeSetContext);
  useEffect(() => {
    set({ topbar: children, contentMaxWidth });
  });
  useEffect(() => () => set(null), [set]);
  return null;
}
