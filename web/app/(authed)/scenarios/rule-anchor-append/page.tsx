'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Backward-compat redirect. 规则页回归一级路由 /rules(IA 收敛,侧栏「规则」
 * 直指真身);本路径保留给旧链接与场景注册表,规则 ops 后端不受影响。
 */
export default function RuleAnchorAppendRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/rules');
  }, [router]);
  return <main className="p-8 text-sm text-[var(--color-muted)]">正在跳转到「规则」…</main>;
}
