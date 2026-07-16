/**
 * Purpose-built migration for replacing a redundant local `type: direct`
 * alias with Mihomo's built-in DIRECT policy.
 *
 * This is intentionally not a generic `proxies:` editor. It accepts exactly
 * one safe shape (`name`, `type: direct`, optional `udp: true`), rewrites the
 * known name references, validates a complete candidate render, then commits
 * base + managed groups + every rule in one Redis script guarded by the
 * global config generation and the base ETag.
 */

import { isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import { parseBase } from '@/lib/engine/parser';
import { resolveConfig } from '@/lib/engine/resolve';
import { validateBase } from '@/lib/engine/validator';
import { ClientSafeProblemDetailsError } from '@/lib/http/problem';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { getBase, type BaseMeta, type BaseRecord } from '@/lib/repos/baseRepo';
import { listCollections } from '@/lib/repos/collectionsRepo';
import { getConfigVersion } from '@/lib/repos/configVersionRepo';
import { getProfile } from '@/lib/repos/profilesRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listProxyGroupTemplates } from '@/lib/repos/proxyGroupTemplatesRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';
import {
  computeEtag,
  ruleProvidersBlockViolations,
  rulesBlockViolations,
} from '@/lib/services/baseService';
import { resolveSubscriptionForPreflight } from '@/lib/services/configPreflight';
import {
  mergeWithTemplate,
  type AuditEvent,
  type ProxyGroup,
  type ProxyGroupTemplate,
  type Rule,
} from '@/schemas';

export const BUILTIN_DIRECT = 'DIRECT';
const SAFE_DIRECT_FIELDS = new Set(['name', 'type', 'udp']);
const COMMA_PAYLOAD_RULE_TYPES = new Set([
  'NOT',
  'OR',
  'AND',
  'DOMAIN-REGEX',
  'PROCESS-NAME-REGEX',
  'PROCESS-PATH-REGEX',
]);

export interface DirectMigrationSummary {
  alias: string;
  replacement: typeof BUILTIN_DIRECT;
  expectedVersion: number;
  removedProxyFields: string[];
  baseProxyDialerReferences: number;
  baseProviderReferences: number;
  baseLiteralGroupReferences: number;
  baseLiteralRuleReferences: number;
  groupsTouched: number;
  groupMemberReferences: number;
  groupOtherReferences: number;
  inheritedTemplateOverrides: number;
  rulesTouched: number;
  enabledRulesTouched: number;
  disabledRulesTouched: number;
  groupNames: string[];
}

interface DirectMigrationCandidate {
  baseContent: string;
  baseMeta: BaseMeta;
  groups: ProxyGroup[];
  rules: Rule[];
  summary: Omit<DirectMigrationSummary, 'expectedVersion'>;
}

export interface DirectMigrationPlan extends DirectMigrationCandidate {
  expectedVersion: number;
  expectedBaseEtag: string;
}

interface StableState {
  version: number;
  base: BaseRecord;
  groups: ProxyGroup[];
  rules: Rule[];
  templates: ProxyGroupTemplate[];
  profile: NonNullable<Awaited<ReturnType<typeof getProfile>>>;
  providers: Awaited<ReturnType<typeof listRuleSets>>;
  subscriptions: Awaited<ReturnType<typeof listSubscriptions>>;
  collections: Awaited<ReturnType<typeof listCollections>>;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function conflictForVersion(expected: number, current: number): ClientSafeProblemDetailsError {
  return ClientSafeProblemDetailsError.conflict(
    `配置在迁移预览后发生了变化（预期版本 ${expected}，当前版本 ${current}），请重新预览。`,
  );
}

function asString(node: unknown): string | null {
  return isScalar(node) && typeof node.value === 'string' ? node.value : null;
}

function replaceScalarField(
  map: YAMLMap,
  field: string,
  alias: string,
  replacement: string,
): number {
  const node = map.get(field, true);
  if (asString(node) !== alias) return 0;
  map.set(field, replacement);
  return 1;
}

function rewriteStringSequence(seq: YAMLSeq, alias: string, replacement: string): number {
  let changed = 0;
  for (let index = 0; index < seq.items.length; index += 1) {
    if (asString(seq.items[index]) !== alias) continue;
    seq.set(index, replacement);
    changed += 1;
  }
  return changed;
}

function replaceRulePolicy(raw: string, alias: string, replacement: string): string | null {
  const fields = raw.split(',');
  const type = fields[0]?.trim().toUpperCase() ?? '';
  let policyIndex: number;
  if (type === 'MATCH') policyIndex = 1;
  else if (COMMA_PAYLOAD_RULE_TYPES.has(type)) policyIndex = fields.length - 1;
  else policyIndex = 2;
  if (policyIndex < 1 || policyIndex >= fields.length) return null;

  const token = fields[policyIndex];
  if (token.replace(/^ +| +$/gu, '') !== alias) return null;
  const leading = token.match(/^ */u)?.[0] ?? '';
  const trailing = token.match(/ *$/u)?.[0] ?? '';
  fields[policyIndex] = `${leading}${replacement}${trailing}`;
  return fields.join(',');
}

function rewriteRuleSequence(seq: YAMLSeq, alias: string, replacement: string): number {
  let changed = 0;
  for (let index = 0; index < seq.items.length; index += 1) {
    const raw = asString(seq.items[index]);
    if (raw === null) continue;
    const next = replaceRulePolicy(raw, alias, replacement);
    if (next === null) continue;
    seq.set(index, next);
    changed += 1;
  }
  return changed;
}

function rewriteLiteralGroups(doc: ReturnType<typeof parseDocument>, alias: string): number {
  const groups = doc.get('proxy-groups', true);
  if (!isSeq(groups)) return 0;
  let changed = 0;
  for (const item of groups.items) {
    if (!isMap(item)) continue;
    const members = item.get('proxies', true);
    if (isSeq(members)) changed += rewriteStringSequence(members, alias, BUILTIN_DIRECT);
    for (const field of ['dialer-proxy', 'empty-fallback', 'default-selected']) {
      changed += replaceScalarField(item, field, alias, BUILTIN_DIRECT);
    }
  }
  return changed;
}

function rewriteProviderMaps(doc: ReturnType<typeof parseDocument>, alias: string): number {
  let changed = 0;
  for (const sectionName of ['proxy-providers', 'rule-providers']) {
    const section = doc.get(sectionName, true);
    if (!isMap(section)) continue;
    for (const pair of section.items) {
      if (!isMap(pair.value)) continue;
      for (const field of ['proxy', 'dialer-proxy']) {
        changed += replaceScalarField(pair.value, field, alias, BUILTIN_DIRECT);
      }
    }
  }
  return changed;
}

function rewriteLiteralRules(doc: ReturnType<typeof parseDocument>, alias: string): number {
  let changed = 0;
  const rules = doc.get('rules', true);
  if (isSeq(rules)) changed += rewriteRuleSequence(rules, alias, BUILTIN_DIRECT);
  const subRules = doc.get('sub-rules', true);
  if (isMap(subRules)) {
    for (const pair of subRules.items) {
      if (isSeq(pair.value)) changed += rewriteRuleSequence(pair.value, alias, BUILTIN_DIRECT);
    }
  }
  return changed;
}

function safePathSegment(node: unknown, fallback: string): string {
  const raw = asString(node);
  if (raw === null || !/^[A-Za-z0-9_.-]{1,80}$/u.test(raw)) return fallback;
  return raw;
}

/** Conservative backstop: an exact alias scalar at an unknown path is not guessed at. */
function findRemainingAliasPaths(node: unknown, alias: string, path = '$'): string[] {
  if (isScalar(node)) return node.value === alias ? [path] : [];
  if (isSeq(node)) {
    return node.items.flatMap((item, index) =>
      findRemainingAliasPaths(item, alias, `${path}[${index}]`),
    );
  }
  if (isMap(node)) {
    return node.items.flatMap((pair, index) => {
      const key = safePathSegment(pair.key, `#${index}`);
      return findRemainingAliasPaths(pair.value, alias, `${path}.${key}`);
    });
  }
  return [];
}

function dedupeMembers(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function migrateManagedGroups(
  groups: ProxyGroup[],
  templates: ProxyGroupTemplate[],
  alias: string,
  updatedAt: number,
): {
  groups: ProxyGroup[];
  touched: ProxyGroup[];
  memberReferences: number;
  otherReferences: number;
  inheritedTemplateOverrides: number;
} {
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const touched: ProxyGroup[] = [];
  let memberReferences = 0;
  let otherReferences = 0;
  let inheritedTemplateOverrides = 0;

  const migrated = groups.map((group) => {
    const next: ProxyGroup = { ...group };
    let changed = false;
    if (group.proxies) {
      memberReferences += group.proxies.filter((member) => member === alias).length;
      const members = dedupeMembers(
        group.proxies.map((member) => (member === alias ? BUILTIN_DIRECT : member)),
      );
      if (
        members.length !== group.proxies.length ||
        members.some((m, i) => m !== group.proxies![i])
      ) {
        next.proxies = members;
        changed = true;
      }
    }

    for (const field of ['dialer-proxy', 'empty-fallback'] as const) {
      if (group[field] === alias) {
        next[field] = BUILTIN_DIRECT;
        otherReferences += 1;
        changed = true;
      }
    }

    // A shared template cannot be rewritten by a profile-scoped operation.
    // Materialise only the inherited reference on this group instead.
    const template = group.template_id ? templateById.get(group.template_id) : undefined;
    if (template) {
      const effective = mergeWithTemplate(group, template);
      for (const field of ['dialer-proxy', 'empty-fallback'] as const) {
        if (group[field] === undefined && effective[field] === alias) {
          next[field] = BUILTIN_DIRECT;
          otherReferences += 1;
          inheritedTemplateOverrides += 1;
          changed = true;
        }
      }
    }

    if (!changed) return group;
    next.updated_at = updatedAt;
    touched.push(next);
    return next;
  });

  return {
    groups: migrated,
    touched,
    memberReferences,
    otherReferences,
    inheritedTemplateOverrides,
  };
}

/** Pure candidate builder, exported for focused safety tests. */
export function buildDirectAliasCandidate(input: {
  base: BaseRecord;
  groups: ProxyGroup[];
  rules: Rule[];
  templates: ProxyGroupTemplate[];
  alias: string;
  updatedAt?: number;
}): DirectMigrationCandidate {
  const { base, groups, rules, templates, alias } = input;
  if (alias.length === 0 || alias.length > 64 || /[\u0000-\u001f\u007f]/u.test(alias)) {
    throw ClientSafeProblemDetailsError.badRequest('alias 必须是 1-64 个字符且不能包含控制字符。');
  }
  const updatedAt = input.updatedAt ?? nowSeconds();
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(base.content);
  } catch {
    throw ClientSafeProblemDetailsError.unprocessable('base.yaml 不是合法 YAML，无法安全迁移。');
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    throw ClientSafeProblemDetailsError.unprocessable(
      'base.yaml 不是合法的顶层 mapping，无法安全迁移。',
    );
  }

  const proxies = doc.get('proxies', true);
  if (!isSeq(proxies)) {
    throw ClientSafeProblemDetailsError.unprocessable('找不到目标自定义直连节点。');
  }
  const matches = proxies.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isMap(item) && asString(item.get('name', true)) === alias);
  if (matches.length !== 1) {
    throw ClientSafeProblemDetailsError.unprocessable(
      matches.length === 0
        ? '找不到目标自定义直连节点。'
        : `发现 ${matches.length} 个同名目标节点，拒绝猜测要删除哪一个。`,
    );
  }

  const directNode = matches[0].item;
  if (!isMap(directNode)) {
    throw ClientSafeProblemDetailsError.unprocessable(
      '目标自定义直连节点不是 mapping，无法安全迁移。',
    );
  }
  const direct = directNode.toJSON() as Record<string, unknown>;
  const fields = Object.keys(direct).sort();
  const safeShape =
    direct.name === alias &&
    direct.type === 'direct' &&
    fields.every((field) => SAFE_DIRECT_FIELDS.has(field)) &&
    (!Object.hasOwn(direct, 'udp') || direct.udp === true);
  if (!safeShape) {
    const semantic = fields.filter((field) => !SAFE_DIRECT_FIELDS.has(field));
    const reason =
      semantic.length > 0
        ? '包含额外语义字段或不安全字段'
        : '仅允许 type: direct 且 udp 缺省或为 true';
    throw ClientSafeProblemDetailsError.unprocessable(
      `目标节点不是可无损替换的冗余直连别名（${reason}），已拒绝迁移。`,
    );
  }

  proxies.items.splice(matches[0].index, 1);

  let baseProxyDialerReferences = 0;
  for (const item of proxies.items) {
    if (isMap(item)) {
      baseProxyDialerReferences += replaceScalarField(item, 'dialer-proxy', alias, BUILTIN_DIRECT);
    }
  }
  const baseProviderReferences = rewriteProviderMaps(doc, alias);
  const baseLiteralGroupReferences = rewriteLiteralGroups(doc, alias);
  const baseLiteralRuleReferences = rewriteLiteralRules(doc, alias);

  const remainingPaths = findRemainingAliasPaths(doc.contents, alias);
  if (remainingPaths.length > 0) {
    throw ClientSafeProblemDetailsError.unprocessable(
      `删除节点后仍发现未识别的目标引用，拒绝自动猜测：${remainingPaths.slice(0, 8).join('、')}${remainingPaths.length > 8 ? '…' : ''}`,
      remainingPaths,
    );
  }

  let baseContent: string;
  try {
    baseContent = doc.toString();
  } catch {
    // yaml may otherwise include an unresolved anchor name in its exception.
    throw ClientSafeProblemDetailsError.unprocessable(
      'base.yaml 含有删除节点后无法解析的 YAML alias，已拒绝迁移。',
    );
  }
  const parsed = parseBase(baseContent);
  const groupMigration = migrateManagedGroups(groups, templates, alias, updatedAt);
  const migratedRules = rules.map((rule) =>
    rule.policy === alias ? { ...rule, policy: BUILTIN_DIRECT, updated_at: updatedAt } : rule,
  );
  const touchedRules = migratedRules.filter((rule, index) => rule !== rules[index]);
  const enabledRulesTouched = touchedRules.filter((rule) => rule.enabled !== false).length;
  const disabledRulesTouched = touchedRules.length - enabledRulesTouched;

  return {
    baseContent,
    baseMeta: {
      etag: computeEtag(baseContent),
      anchors: parsed.anchors,
      policies: parsed.policies,
      updated_at: updatedAt,
    },
    groups: groupMigration.touched,
    rules: touchedRules,
    summary: {
      alias,
      replacement: BUILTIN_DIRECT,
      removedProxyFields: fields,
      baseProxyDialerReferences,
      baseProviderReferences,
      baseLiteralGroupReferences,
      baseLiteralRuleReferences,
      groupsTouched: groupMigration.touched.length,
      groupMemberReferences: groupMigration.memberReferences,
      groupOtherReferences: groupMigration.otherReferences,
      inheritedTemplateOverrides: groupMigration.inheritedTemplateOverrides,
      rulesTouched: touchedRules.length,
      enabledRulesTouched,
      disabledRulesTouched,
      groupNames: groupMigration.touched.map((group) => group.name),
    },
  };
}

async function loadStableState(profileId: string, expectedVersion?: number): Promise<StableState> {
  const version = await getConfigVersion();
  if (expectedVersion !== undefined && version !== expectedVersion) {
    throw conflictForVersion(expectedVersion, version);
  }
  const [base, groups, rules, templates, profile, providers, subscriptions, collections] =
    await Promise.all([
      getBase(profileId),
      listProxyGroups(profileId),
      listRules(profileId),
      listProxyGroupTemplates(),
      getProfile(profileId),
      listRuleSets(),
      listSubscriptions(),
      listCollections(),
    ]);
  if (!base) throw ClientSafeProblemDetailsError.unprocessable('base.yaml 尚未初始化。');
  if (!profile) throw ClientSafeProblemDetailsError.notFound('目标 profile 不存在。');
  const after = await getConfigVersion();
  if (after !== version) throw conflictForVersion(version, after);
  return {
    version,
    base,
    groups,
    rules,
    templates,
    profile,
    providers,
    subscriptions,
    collections,
  };
}

async function validateCandidate(
  state: StableState,
  candidate: DirectMigrationCandidate,
): Promise<void> {
  const allGroups = state.groups.map(
    (group) => candidate.groups.find((next) => next.id === group.id) ?? group,
  );
  const allRules = state.rules.map(
    (rule) => candidate.rules.find((next) => next.id === rule.id) ?? rule,
  );
  const parsed = parseBase(candidate.baseContent);
  const validation = validateBase(
    parsed,
    allRules,
    new Set(state.providers.map((provider) => provider.name)),
    allGroups.map((group) => group.name),
  );
  const blockViolations = [
    ...rulesBlockViolations(candidate.baseContent),
    ...ruleProvidersBlockViolations(candidate.baseContent),
  ];
  if (!validation.valid || blockViolations.length > 0) {
    const errors = [...validation.orphans, ...blockViolations];
    throw ClientSafeProblemDetailsError.unprocessable(
      '迁移候选会留下无效引用，已拒绝写入。',
      errors,
    );
  }

  // Authoritative end-to-end validation: materialise subscription nodes,
  // templates, groups, providers and enabled rules exactly as production does.
  await resolveConfig(
    candidate.baseContent,
    allRules,
    state.subscriptions,
    allGroups,
    state.templates,
    {
      providers: state.providers,
      ignoreFailedSubs: false,
      persistSnapshot: false,
      subscriptionResolver: resolveSubscriptionForPreflight,
      collections: state.collections,
      boundSource: state.profile.source,
    },
  );
}

export async function planDirectAliasMigration(
  profileId: string,
  alias = '直连',
  expectedVersion?: number,
  expectedBaseEtag?: string,
): Promise<DirectMigrationPlan> {
  const state = await loadStableState(profileId, expectedVersion);
  if (expectedBaseEtag !== undefined && state.base.etag !== expectedBaseEtag) {
    throw ClientSafeProblemDetailsError.conflict(
      'base.yaml 与迁移预览时的 ETag 不一致，请重新预览。',
    );
  }
  const sharedProviderRefs = state.providers
    .filter((provider) => provider.proxy === alias)
    .map((provider) => provider.name);
  if (sharedProviderRefs.length > 0) {
    throw ClientSafeProblemDetailsError.unprocessable(
      `共享规则集仍通过 proxy 引用「${alias}」，profile 级迁移不能安全改写全局资源：${sharedProviderRefs.join('、')}`,
      sharedProviderRefs,
    );
  }
  const candidate = buildDirectAliasCandidate({
    base: state.base,
    groups: state.groups,
    rules: state.rules,
    templates: state.templates,
    alias,
  });
  await validateCandidate(state, candidate);
  const afterValidation = await getConfigVersion();
  if (afterValidation !== state.version) throw conflictForVersion(state.version, afterValidation);
  return {
    ...candidate,
    expectedVersion: state.version,
    expectedBaseEtag: state.base.etag,
  };
}

const COMMIT_DIRECT_MIGRATION = `
local currentVersion = redis.call('GET', KEYS[1]) or '0'
if currentVersion ~= ARGV[1] then return {0, currentVersion} end

local currentMetaRaw = redis.call('GET', KEYS[3])
local currentEtag = ''
if currentMetaRaw then
  local ok, currentMeta = pcall(cjson.decode, currentMetaRaw)
  if ok and type(currentMeta) == 'table' and currentMeta.etag ~= nil then
    currentEtag = tostring(currentMeta.etag)
  end
end
if currentEtag ~= ARGV[2] then return {-1, currentVersion} end

redis.call('SET', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[4])

local index = 6
local groupCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, groupCount do
  redis.call('HSET', KEYS[4], ARGV[index], ARGV[index + 1])
  index = index + 2
end

local ruleCount = tonumber(ARGV[index])
index = index + 1
for _ = 1, ruleCount do
  redis.call('HSET', KEYS[5], ARGV[index], ARGV[index + 1])
  index = index + 2
end

redis.call('HDEL', KEYS[6], ARGV[5])
local eventId = ARGV[index]
local eventTs = tonumber(ARGV[index + 1])
local eventJson = ARGV[index + 2]
redis.call('ZADD', KEYS[7], eventTs, eventId)
redis.call('HSET', KEYS[8], eventId, eventJson)
local auditCount = redis.call('ZCARD', KEYS[7])
if auditCount > 1000 then
  local overflow = auditCount - 1000
  local evicted = redis.call('ZRANGE', KEYS[7], 0, overflow - 1)
  redis.call('ZREMRANGEBYRANK', KEYS[7], 0, overflow - 1)
  for _, oldId in ipairs(evicted) do redis.call('HDEL', KEYS[8], oldId) end
end
local nextVersion = redis.call('INCR', KEYS[1])
return {1, nextVersion, eventId}
`.trim();

async function commitPlan(
  profileId: string,
  actor: string,
  plan: DirectMigrationPlan,
): Promise<{ newVersion: number; auditEventId: string }> {
  const event: AuditEvent = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    op: 'direct-migration.replace-alias',
    actor,
    target: { kind: 'base', field: 'proxies' },
    before: {
      alias: plan.summary.alias,
      fields: plan.summary.removedProxyFields,
      groupsTouched: plan.summary.groupsTouched,
      rulesTouched: plan.summary.rulesTouched,
    },
    after: { replacement: BUILTIN_DIRECT },
    profileId,
  };
  const args: string[] = [
    String(plan.expectedVersion),
    plan.expectedBaseEtag,
    plan.baseContent,
    JSON.stringify(plan.baseMeta),
    profileId,
    String(plan.groups.length),
  ];
  for (const group of plan.groups) args.push(group.id, JSON.stringify(group));
  args.push(String(plan.rules.length));
  for (const rule of plan.rules) args.push(rule.id, JSON.stringify(rule));
  args.push(event.id, String(event.ts), JSON.stringify(event));

  const result = (await getRedis().eval(
    COMMIT_DIRECT_MIGRATION,
    [
      REDIS_KEYS.configVersion,
      REDIS_KEYS.base.content(profileId),
      REDIS_KEYS.base.meta(profileId),
      REDIS_KEYS.proxyGroups(profileId),
      REDIS_KEYS.rules(profileId),
      REDIS_KEYS.resolvedSnapshot,
      REDIS_KEYS.audit.events,
      REDIS_KEYS.audit.byId,
    ],
    args,
  )) as [number, number | string, string?];
  if (!Array.isArray(result) || result[0] !== 1) {
    if (Array.isArray(result) && result[0] === -1) {
      throw ClientSafeProblemDetailsError.conflict(
        'base.yaml 在迁移期间被其他写入修改，请重新预览。',
      );
    }
    const current = Number(Array.isArray(result) ? result[1] : NaN);
    throw conflictForVersion(plan.expectedVersion, Number.isSafeInteger(current) ? current : -1);
  }
  return { newVersion: Number(result[1]), auditEventId: result[2] ?? event.id };
}

export async function executeDirectAliasMigration(
  profileId: string,
  alias: string,
  expectedVersion: number,
  expectedBaseEtag: string,
  actor: string,
): Promise<{ summary: DirectMigrationSummary; newVersion: number; auditEventId: string }> {
  // Rebuild and fully validate the exact current candidate. The version is
  // the snapshot the confirmation card showed; any intervening write aborts.
  const plan = await planDirectAliasMigration(profileId, alias, expectedVersion, expectedBaseEtag);
  const { newVersion, auditEventId } = await commitPlan(profileId, actor, plan);
  return {
    summary: { ...plan.summary, expectedVersion: plan.expectedVersion },
    newVersion,
    auditEventId,
  };
}
