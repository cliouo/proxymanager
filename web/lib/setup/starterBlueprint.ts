import { parseBase } from '@/lib/engine/parser';
import { computeEtag } from '@/lib/services/baseService';
import {
  ProfileSchema,
  ProxyGroupSchema,
  RuleSchema,
  SETUP_STARTER_VERSION,
  type Profile,
  type ProxyGroup,
  type Rule,
} from '@/schemas';
import type { BaseMeta } from '@/lib/repos/baseRepo';

export const STARTER_BLUEPRINT_ID = 'starter';
export const STARTER_BLUEPRINT_VERSION = SETUP_STARTER_VERSION;
export const STARTER_PROFILE_ID = '35000000-0000-4000-8000-000000000001';

const AUTO_GROUP_ID = '35000000-0000-4000-8000-000000000002';
const DEFAULT_GROUP_ID = '35000000-0000-4000-8000-000000000003';
const MATCH_RULE_ID = '35000000-0000-4000-8000-000000000004';

export function buildStarterBaseContent(): string {
  return `allow-lan: false
mode: rule
log-level: info

# === RULE-PROVIDERS ===

# === PROXY-GROUPS ===

rules:
  # === ANCHOR: prelude ===
  # === ANCHOR: manual ===
  # === ANCHOR: late ===
`;
}

export const STARTER_BASE_CONTENT = buildStarterBaseContent();

export interface StarterBlueprint {
  id: typeof STARTER_BLUEPRINT_ID;
  version: typeof STARTER_BLUEPRINT_VERSION;
  profile: Profile;
  baseContent: string;
  baseMeta: BaseMeta;
  proxyGroups: ProxyGroup[];
  rules: Rule[];
}

/** Build one internally versioned, schema-checked starter candidate. */
export function buildStarterBlueprint(now: number): StarterBlueprint {
  const baseContent = buildStarterBaseContent();
  const profile = ProfileSchema.parse({
    id: STARTER_PROFILE_ID,
    name: 'default',
    display_name: '默认配置',
    source: { type: 'none' },
    kind: 'normal',
    notes: `setup-bootstrap:${STARTER_BLUEPRINT_VERSION}`,
    created_at: now,
    updated_at: now,
  });
  const proxyGroups = [
    ProxyGroupSchema.parse({
      id: AUTO_GROUP_ID,
      kind: 'all',
      section: '基础',
      rank: 10,
      notes: `setup-bootstrap:${STARTER_BLUEPRINT_VERSION}`,
      created_at: now,
      updated_at: now,
      name: '自动选择',
      type: 'url-test',
      'include-all-proxies': true,
      'empty-fallback': 'DIRECT',
      url: 'http://www.gstatic.com/generate_204',
      interval: 600,
      tolerance: 50,
      lazy: true,
    }),
    ProxyGroupSchema.parse({
      id: DEFAULT_GROUP_ID,
      kind: 'manual',
      section: '基础',
      rank: 20,
      notes: `setup-bootstrap:${STARTER_BLUEPRINT_VERSION}`,
      created_at: now,
      updated_at: now,
      name: '默认',
      type: 'select',
      proxies: ['自动选择', 'DIRECT'],
    }),
  ];
  const rules = [
    RuleSchema.parse({
      id: MATCH_RULE_ID,
      anchor: 'late',
      type: 'MATCH',
      value: '',
      policy: '默认',
      rank: 1_000_000,
      source: 'manual',
      enabled: true,
      added_at: now,
      updated_at: now,
      note: `setup-bootstrap:${STARTER_BLUEPRINT_VERSION}`,
    }),
  ];
  const parsed = parseBase(baseContent);
  return {
    id: STARTER_BLUEPRINT_ID,
    version: STARTER_BLUEPRINT_VERSION,
    profile,
    baseContent,
    baseMeta: {
      etag: computeEtag(baseContent),
      anchors: parsed.anchors,
      policies: parsed.policies,
      updated_at: now,
    },
    proxyGroups,
    rules,
  };
}
