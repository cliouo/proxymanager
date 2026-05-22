'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Backward-compat redirect. The Rules editor moved under the scenarios
 * framework so it sits alongside other config-editing scenarios in the
 * sidebar. /rules → /scenarios/rule-anchor-append.
 */
export default function RulesRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/scenarios/rule-anchor-append');
  }, [router]);
  return (
    <main className="p-8 text-sm text-[var(--color-muted)]">
      正在跳转到「规则编辑」…
    </main>
  );
}
