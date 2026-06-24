'use client';

import { usePathname } from 'next/navigation';
import { useAssistant } from '@/components/assistant/AssistantContext';
import { titleForPath } from '@/components/nav';
import { usePageChrome } from '@/components/PageChrome';
import { useProfiles } from '@/components/profile/ProfileContext';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

/** 账户级共享资源路由 —— 这些页不属于某个配置文件,所有配置文件共用。 */
const SHARED_PREFIXES = ['/subscriptions', '/rule-sets', '/collections'];

/**
 * 作用域标签。页面注入自定义 topbar 时按原型自带:
 * 默认 = 青色当前配置文件名;`shared` = 紫色「账户共享」(订阅源 / 规则集等账户级资源页)。
 */
export function ScopePill({ shared }: { shared?: boolean }) {
  const { activeProfile } = useProfiles();
  if (shared) {
    return (
      <span className="pill ai plain tb-scope" title="账户级共享资源 · 所有配置文件共用">
        账户共享
      </span>
    );
  }
  if (!activeProfile) return null;
  return (
    <span className="pill acc plain tb-scope" title="正在编辑的配置文件">
      {activeProfile.name}
    </span>
  );
}

/**
 * v2 粘性 topbar：移动端汉堡键 + 路由标题 + scope 标签 + 主题切换器 + AI 助手触发钮。
 *
 * 页面可经 <PageTopbar> 注入整段自定义内容(返回链 / 标题 / pill / crumb / 主操作钮,
 * 对齐 v2 原型把页头放进 topbar 的做法);未注入时按路由渲染默认标题区。
 *
 * scope 标签区分作用域(对齐 v2 原型):共享资源页显示紫色「账户共享」,
 * 配置文件内容页显示青色的当前配置文件名。引擎当前只渲染 default,故名取 ProfilesContext.current。
 */
export function Topbar({ onMenu }: { onMenu: () => void }) {
  const pathname = usePathname();
  const title = titleForPath(pathname);
  const assistant = useAssistant();
  const { activeProfile } = useProfiles();
  const chrome = usePageChrome();

  const shared = SHARED_PREFIXES.some((p) => pathname.startsWith(p));
  // 管理/系统页(配置文件总览、AI 配置、API 文档)不挂作用域标签,避免暗示错误的归属。
  const managementOnly =
    pathname.startsWith('/profiles') ||
    pathname.startsWith('/assistant-settings') ||
    pathname.startsWith('/docs');

  return (
    <header className="topbar">
      <button
        type="button"
        className="btn ghost sm menu-btn"
        onClick={onMenu}
        aria-label="打开导航"
      >
        ☰
      </button>
      {chrome?.topbar ?? (
        <>
          <h1>{title}</h1>
          {shared ? (
            <span className="pill ai plain tb-scope" title="账户级共享资源 · 所有配置文件共用">
              账户共享
            </span>
          ) : (
            !managementOnly &&
            activeProfile && (
              <span className="pill acc plain tb-scope" title="正在编辑的配置文件">
                {activeProfile.name}
              </span>
            )
          )}
          <div className="grow" />
        </>
      )}
      <ThemeToggle />
      <button
        type="button"
        className="ai-fab"
        onClick={assistant.toggle}
        aria-label="配置助手"
        aria-expanded={assistant.open}
      >
        <span className="spark">✦</span>
        助手
      </button>
    </header>
  );
}
