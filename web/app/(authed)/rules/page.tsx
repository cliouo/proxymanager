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
    <main className="p-6 text-sm text-[var(--color-muted)]">
      Redirecting to /scenarios/rule-anchor-append…
    </main>
  );
}
