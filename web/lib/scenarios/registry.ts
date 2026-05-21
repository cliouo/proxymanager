/**
 * Scenario registry — central index of every scenario the dispatcher and
 * sidebar know about.
 *
 * To register a new scenario:
 *   1. Add a module under `web/lib/scenarios/{id}/scenario.ts` exporting a
 *      `Scenario` value (see _echo for the minimum shape).
 *   2. Import + add it to `ALL_SCENARIOS` below.
 *   3. If it needs UI, create `web/app/(authed)/scenarios/{id}/page.tsx`
 *      whose path matches the descriptor's `navHref`.
 *
 * That's it — sidebar, ops endpoint, and audit log all pick it up by
 * iterating this list.
 */

import { chainedProxyScenario } from './chained-proxy/scenario';
import { echoScenario } from './dev-echo/scenario';
import { ruleAnchorAppendScenario } from './rule-anchor-append/scenario';
import type { Scenario, ScenarioDescriptor } from './_shared/types';

const ALL_SCENARIOS: Scenario[] = [
  ruleAnchorAppendScenario,
  chainedProxyScenario,
  echoScenario,
];

const byId = new Map(ALL_SCENARIOS.map((s) => [s.descriptor.id, s]));

export function getScenario(id: string): Scenario | undefined {
  return byId.get(id);
}

export function listScenarios(): ScenarioDescriptor[] {
  return ALL_SCENARIOS.map((s) => s.descriptor);
}
