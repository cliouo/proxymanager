/**
 * P-FFP v2 I15: the failed-no-cache disposition copy is owned HERE — one
 * pure formatter and one exact four-row table. Both authed pages (dashboard
 * and subscription list/card/distribution) consume this module; no
 * page-local fallback copy may diverge.
 *
 * Contract:
 *   - `unavailable`  — no cache was found (未找到可用缓存)
 *   - `invalid`      — cache validation failed (缓存校验未通过)
 *   - `policy-blocked` — the failure policy prevented using an EXISTING cache
 *     (must not imply no cache existed or that validation failed)
 *   - `bypassed`     — forced refresh did not read or serve cache
 * Every sentence states that no cache was served. A malformed or absent
 * disposition may use ONLY the generic fallback. `stale-served` alone may
 * say 已沿用上次缓存对外下发.
 */

export const SUBSCRIPTION_FETCH_FAILURE_DISPOSITION_COPY = {
  unavailable: '未找到可用缓存，本次未下发缓存',
  invalid: '缓存校验未通过，本次未下发缓存',
  'policy-blocked': '失败策略阻止使用现有缓存，本次未下发缓存',
  bypassed: '本次为强制刷新，未读取或下发缓存',
} as const;

export type SubscriptionFetchFailureDisposition =
  keyof typeof SUBSCRIPTION_FETCH_FAILURE_DISPOSITION_COPY;

/** The ONLY fallback for a malformed or absent disposition (v2 I15). */
export const SUBSCRIPTION_FETCH_FAILURE_GENERIC_COPY = '本次未下发缓存（缓存处置未知）';

/**
 * Pure formatter: maps the fixed failed-no-cache disposition values
 * one-to-one onto the I15 table; anything else (absent, 'served', unknown)
 * uses only the generic fallback. Never claims a cache was served.
 */
export function describeFailedDisposition(disposition: string | undefined): string {
  switch (disposition) {
    case 'unavailable':
    case 'invalid':
    case 'policy-blocked':
    case 'bypassed':
      return SUBSCRIPTION_FETCH_FAILURE_DISPOSITION_COPY[disposition];
    default:
      return SUBSCRIPTION_FETCH_FAILURE_GENERIC_COPY;
  }
}
