import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml';
import { parseBase } from '@/lib/engine/parser';
import { renderBase, renderRule } from '@/lib/engine/renderer';
import { ProblemDetailsError } from '@/lib/http/problem';
import { recordEvent } from '@/lib/repos/auditRepo';
import { computeEtag } from '@/lib/services/baseService';
import { getProfileByName } from '@/lib/repos/profilesRepo';
import { commitTailscaleDeviceMigration } from '@/lib/repos/tailscaleDeviceMigrationRepo';
import { preflightProfileConfig, type ProfileConfigState } from '@/lib/services/configPreflight';
import {
  TailscaleDeviceFeatureSchema,
  publicDeviceFeatures,
  type Device,
  type ProxyGroup,
  type Rule,
  type TailscaleDeviceFeature,
} from '@/schemas';

const TAILNET_CIDR = '100.64.0.0/10';
const SUPPORTED_NODE_KEYS = new Set([
  'name',
  'type',
  'hostname',
  'auth-key',
  'control-url',
  'state-dir',
  'ephemeral',
  'udp',
  'accept-routes',
  'exit-node',
  'exit-node-allow-lan-access',
]);
const GROUP_RUNTIME_FIELDS = [
  'template_id',
  'bound_subscription_id',
  'bound_collection_id',
  'legacy_type',
  'legacy_dialer_proxy',
  'use',
  'include-all-providers',
  'include-all-proxies',
  'include-all',
  'filter',
  'exclude-filter',
  'exclude-type',
  'empty-fallback',
  'url',
  'interval',
  'tolerance',
  'lazy',
  'expected-status',
  'max-failed-times',
  'timeout',
  'strategy',
  'dialer-proxy',
  'routing-mark',
  'disable-udp',
  'hidden',
  'icon',
] as const;

interface LegacyNode {
  nodeName: string;
  feature: TailscaleDeviceFeature;
  baseContent: string;
}

function removeBlockSequenceItem(content: string, node: YAMLMap, sequenceLength: number): string {
  if (!node.range) fixedError('旧版 Tailscale 节点缺少源码范围，无法安全迁移。');
  const [start, , end] = node.range;
  const lineStart = content.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const itemPrefix = content.slice(lineStart, start);
  if (!/^[ \t]*-[ \t]+$/.test(itemPrefix)) {
    fixedError('旧版 Tailscale 节点不是受支持的块列表写法，无法保真移除。');
  }
  if (sequenceLength > 1) {
    return content.slice(0, lineStart) + content.slice(end);
  }

  const proxyKeys = [...content.matchAll(/^proxies:[ \t]*(?:#[^\n]*)?\n/gm)].filter(
    (match) => match.index !== undefined && match.index < lineStart,
  );
  const key = proxyKeys.at(-1);
  if (!key || key.index === undefined) {
    fixedError('无法定位旧版 base 的 proxies 区块，未执行迁移。');
  }
  return `${content.slice(0, key.index)}proxies: []\n${content.slice(end)}`;
}

export interface TailscaleDeviceMigrationSummary {
  profile: { id: string; name: string };
  device: { id: string; name: string };
  nodeName: string;
  groupName: string;
  hostname: string;
  hasAuthKey: boolean;
  ruleCount: number;
  extraCidrs: string[];
}

export interface TailscaleDeviceMigrationPlan {
  summary: TailscaleDeviceMigrationSummary;
  profileId: string;
  expectedVersion: number;
  baseContent: string;
  baseMeta: {
    etag: string;
    anchors: string[];
    policies: string[];
    updated_at: number;
  };
  device: Device;
  ruleDeletes: string[];
  proxyGroupDeletes: string[];
  backupKey: string;
  backupValue: unknown;
}

function fixedError(message: string): never {
  throw ProblemDetailsError.unprocessable(message);
}

function canonicalControlUrl(value: string | undefined): string {
  const parsed = new URL(value ?? 'https://controlplane.tailscale.com');
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
}

function readString(node: YAMLMap, key: string): string | undefined {
  if (!node.has(key)) return undefined;
  const value = node.get(key);
  if (typeof value !== 'string') {
    fixedError(`旧版 Tailscale 字段「${key}」存在但不是字符串，无法安全迁移。`);
  }
  return value;
}

function readBoolean(node: YAMLMap, key: string): boolean | undefined {
  if (!node.has(key)) return undefined;
  const value = node.get(key);
  if (typeof value !== 'boolean') {
    fixedError(`旧版 Tailscale 字段「${key}」存在但不是布尔值，无法安全迁移。`);
  }
  return value;
}

function extractLegacyNode(content: string): LegacyNode {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) fixedError('旧版 base 不是合法 YAML，无法安全迁移。');
  const proxies = doc.get('proxies', true);
  if (!isSeq(proxies)) fixedError('旧版 base 的 proxies 不是列表，无法安全迁移。');

  const matches = proxies.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isMap(item) && item.get('type') === 'tailscale');
  if (matches.length !== 1) {
    fixedError(
      matches.length === 0
        ? '没有发现旧版共享 Tailscale 节点。'
        : `发现 ${matches.length} 个旧版共享 Tailscale 节点；迁移只接受单一、可证明无歧义的实例。`,
    );
  }

  const match = matches[0];
  if (!isMap(match.item)) fixedError('旧版 Tailscale 节点结构无效。');
  const node = match.item;
  const raw = node.toJSON() as Record<string, unknown>;
  const unsupported = Object.keys(raw).filter((key) => !SUPPORTED_NODE_KEYS.has(key));
  if (unsupported.length > 0) {
    fixedError(`旧版 Tailscale 节点含迁移器不支持的字段：${unsupported.join('、')}。`);
  }

  const nodeName = readString(node, 'name');
  const hostname = readString(node, 'hostname');
  if (!nodeName || !hostname) {
    fixedError('旧版 Tailscale 节点必须同时具有 name 与 hostname，才能无损迁移。');
  }
  const authKey = readString(node, 'auth-key');
  const feature = TailscaleDeviceFeatureSchema.parse({
    hostname,
    ...(authKey ? { authKey } : {}),
    ...(readString(node, 'control-url') ? { controlUrl: readString(node, 'control-url') } : {}),
    ...(readString(node, 'state-dir') ? { stateDir: readString(node, 'state-dir') } : {}),
    ...(readString(node, 'exit-node') ? { exitNode: readString(node, 'exit-node') } : {}),
    ...(readBoolean(node, 'ephemeral') !== undefined
      ? { ephemeral: readBoolean(node, 'ephemeral') }
      : {}),
    ...(readBoolean(node, 'udp') !== undefined ? { udp: readBoolean(node, 'udp') } : {}),
    ...(readBoolean(node, 'accept-routes') !== undefined
      ? { acceptRoutes: readBoolean(node, 'accept-routes') }
      : {}),
    ...(readBoolean(node, 'exit-node-allow-lan-access') !== undefined
      ? { exitNodeAllowLanAccess: readBoolean(node, 'exit-node-allow-lan-access') }
      : {}),
    nodeName,
    extraCidrs: [],
  });

  return {
    nodeName,
    feature,
    baseContent: removeBlockSequenceItem(content, node, proxies.items.length),
  };
}

function findManagedGroup(state: Readonly<ProfileConfigState>, nodeName: string): ProxyGroup {
  const referencing = state.proxyGroups.filter((group) => {
    const members = group.proxies ?? [];
    return members.includes(nodeName) || group['dialer-proxy'] === nodeName;
  });
  if (referencing.length !== 1) {
    fixedError(
      `旧版节点必须只被一个单成员 select 策略组引用；当前找到 ${referencing.length} 个关联组。`,
    );
  }
  const group = referencing[0];
  if (
    group.type !== 'select' ||
    group.proxies?.length !== 1 ||
    group.proxies[0] !== nodeName ||
    GROUP_RUNTIME_FIELDS.some((field) => group[field] !== undefined)
  ) {
    fixedError(`策略组「${group.name}」不是可无损迁移的单成员 select 形态。`);
  }
  return group;
}

function findManagedRules(
  state: Readonly<ProfileConfigState>,
  nodeName: string,
  groupName: string,
): { rules: Rule[]; extraCidrs: string[] } {
  const rules = state.rules.filter((rule) => rule.policy === groupName || rule.policy === nodeName);
  if (rules.length === 0) fixedError(`没有找到指向策略组「${groupName}」的旧版路由规则。`);
  for (const rule of rules) {
    const options = rule.options ?? [];
    if (
      rule.enabled === false ||
      (rule.type !== 'IP-CIDR' && rule.type !== 'IP-CIDR6') ||
      options.length !== 1 ||
      options[0] !== 'no-resolve'
    ) {
      fixedError(`规则「${rule.id}」不是可无损迁移的 IP-CIDR + no-resolve 形态。`);
    }
  }
  const cidrs = [...new Set(rules.map((rule) => rule.value))];
  if (cidrs.length !== rules.length) {
    fixedError('旧版 Tailscale 路由含重复 CIDR；设备功能会去重，无法按无损迁移处理。');
  }
  for (const rule of rules) {
    const expectedType = rule.value.includes(':') ? 'IP-CIDR6' : 'IP-CIDR';
    if (rule.type !== expectedType) {
      fixedError(`规则「${rule.id}」的类型与 CIDR 地址族不一致，无法安全迁移。`);
    }
  }
  if (!cidrs.includes(TAILNET_CIDR)) {
    fixedError(`旧版规则缺少 ${TAILNET_CIDR}，无法证明它是完整的 Tailscale 接入。`);
  }
  return { rules, extraCidrs: cidrs.filter((cidr) => cidr !== TAILNET_CIDR) };
}

/**
 * 设备功能作为设备覆盖固定在最终规则链开头注入。迁移只有在旧规则本来就占据
 * 开头的连续位置时才是语义保真的；否则它会跨过其它规则，Mihomo 的首条命中结果
 * 可能改变。任何重复渲染行也会让位置证明失去唯一性，因此一律拒绝。
 */
function assertRulePlacementPreserved(
  state: Readonly<ProfileConfigState>,
  managedRules: readonly Rule[],
): void {
  const rendered = renderBase(state.baseContent, state.rules, {
    providers: state.ruleSets,
  });
  const doc = parseDocument(rendered.content);
  if (doc.errors.length > 0) fixedError('旧版完整配置不是合法 YAML，无法证明规则顺序。');
  const ruleSequence = doc.get('rules', true);
  if (!isSeq(ruleSequence)) fixedError('旧版完整配置的 rules 不是列表，无法证明规则顺序。');
  const lines = ruleSequence.items.map((item) =>
    isScalar(item) && typeof item.value === 'string' ? item.value : null,
  );
  if (lines.some((line) => line === null)) {
    fixedError('旧版完整配置含非字符串规则，无法证明规则顺序。');
  }

  const positions: number[] = [];
  for (const rule of managedRules) {
    const line = renderRule(rule);
    const matches = lines.flatMap((candidate, index) => (candidate === line ? [index] : []));
    if (matches.length !== 1) {
      fixedError(`规则「${rule.id}」在最终配置中无法唯一定位，未执行迁移。`);
    }
    positions.push(matches[0]);
  }
  positions.sort((a, b) => a - b);

  const placementIsExact =
    positions.length > 0 && positions.every((position, index) => position === index);
  if (!placementIsExact) {
    fixedError(
      '旧版 Tailscale 规则不在最终规则链开头连续排列；自动迁移会改变规则优先级，请先手动调整规则顺序。',
    );
  }
}

function buildMigrationCandidate(
  state: Readonly<ProfileConfigState>,
  deviceName: string,
): {
  patch: Pick<ProfileConfigState, 'baseContent' | 'proxyGroups' | 'rules' | 'devices'>;
  device: Device;
  nodeName: string;
  group: ProxyGroup;
  rules: Rule[];
  feature: TailscaleDeviceFeature;
} {
  const target = state.devices.find((device) => device.name === deviceName);
  if (!target) fixedError(`设备「${deviceName}」不存在。`);
  if (target.features?.tailscale) fixedError(`设备「${deviceName}」已经启用 Tailscale。`);

  const legacy = extractLegacyNode(state.baseContent);
  const group = findManagedGroup(state, legacy.nodeName);
  const dependentGroups = state.proxyGroups.filter(
    (candidate) =>
      candidate.id !== group.id &&
      ((candidate.proxies ?? []).includes(group.name) || candidate['dialer-proxy'] === group.name),
  );
  if (dependentGroups.length > 0) {
    fixedError(
      `策略组「${group.name}」仍被其它共享策略组引用：${dependentGroups
        .map((candidate) => candidate.name)
        .join('、')}。设备功能不能成为共享组的成员，请先解除引用。`,
    );
  }
  const managedRules = findManagedRules(state, legacy.nodeName, group.name);
  assertRulePlacementPreserved(state, managedRules.rules);
  const feature = TailscaleDeviceFeatureSchema.parse({
    ...legacy.feature,
    groupName: group.name,
    extraCidrs: managedRules.extraCidrs,
  });
  if (state.profile.kind === 'template') {
    fixedError('模版不保存设备身份功能；请迁移到普通配置文件的具体设备。');
  }

  const duplicate = state.devices.find(
    (device) =>
      device.id !== target.id &&
      device.features?.tailscale &&
      device.features.tailscale.hostname.toLowerCase() === feature.hostname.toLowerCase() &&
      canonicalControlUrl(device.features.tailscale.controlUrl) ===
        canonicalControlUrl(feature.controlUrl),
  );
  if (duplicate) {
    fixedError(`设备「${duplicate.name}」已使用相同的 control-url + hostname。`);
  }

  const updated: Device = {
    ...target,
    features: { ...(target.features ?? {}), tailscale: feature },
    updated_at: Math.floor(Date.now() / 1000),
  };
  return {
    patch: {
      baseContent: legacy.baseContent,
      proxyGroups: state.proxyGroups.filter((candidate) => candidate.id !== group.id),
      rules: state.rules.filter(
        (candidate) => !managedRules.rules.some((rule) => rule.id === candidate.id),
      ),
      devices: state.devices.map((device) => (device.id === target.id ? updated : device)),
    },
    device: updated,
    nodeName: legacy.nodeName,
    group,
    rules: managedRules.rules,
    feature,
  };
}

export async function planTailscaleDeviceMigration(
  profileName: string,
  deviceName: string,
): Promise<TailscaleDeviceMigrationPlan> {
  const profile = await getProfileByName(profileName);
  if (!profile) throw ProblemDetailsError.notFound(`配置文件「${profileName}」不存在。`);

  const holder: {
    planned?: ReturnType<typeof buildMigrationCandidate>;
    original?: Readonly<ProfileConfigState>;
  } = {};
  const checked = await preflightProfileConfig(profile.id, (state) => {
    holder.original = state;
    holder.planned = buildMigrationCandidate(state, deviceName);
    return holder.planned.patch;
  });
  if (!holder.planned || !holder.original) {
    throw ProblemDetailsError.preconditionFailed('迁移候选未能生成，请重试。');
  }
  const result = holder.planned;
  const before = holder.original;
  const parsedBase = parseBase(result.patch.baseContent);
  const updatedAt = Math.floor(Date.now() / 1000);
  const backupKey = `backup:migrate-tailscale-device:${profile.id}:${Date.now()}`;
  return {
    summary: {
      profile: { id: profile.id, name: profile.name },
      device: { id: result.device.id, name: result.device.name },
      nodeName: result.nodeName,
      groupName: result.group.name,
      hostname: result.feature.hostname,
      hasAuthKey: Boolean(result.feature.authKey),
      ruleCount: result.rules.length,
      extraCidrs: result.feature.extraCidrs,
    },
    profileId: profile.id,
    expectedVersion: checked.configVersion,
    baseContent: result.patch.baseContent,
    baseMeta: {
      etag: computeEtag(result.patch.baseContent),
      anchors: parsedBase.anchors,
      policies: parsedBase.policies,
      updated_at: updatedAt,
    },
    device: result.device,
    ruleDeletes: result.rules.map((rule) => rule.id),
    proxyGroupDeletes: [result.group.id],
    backupKey,
    backupValue: {
      profile: { id: profile.id, name: profile.name },
      baseContent: before.baseContent,
      device: before.devices.find((device) => device.id === result.device.id),
      proxyGroup: result.group,
      rules: result.rules,
      configVersion: checked.configVersion,
    },
  };
}

export async function executeTailscaleDeviceMigration(
  plan: TailscaleDeviceMigrationPlan,
): Promise<{ backupKey: string; auditRecorded: boolean }> {
  const committed = await commitTailscaleDeviceMigration(plan.profileId, {
    expectedVersion: plan.expectedVersion,
    baseContent: plan.baseContent,
    baseMeta: plan.baseMeta,
    device: plan.device,
    ruleDeletes: plan.ruleDeletes,
    proxyGroupDeletes: plan.proxyGroupDeletes,
    backupKey: plan.backupKey,
    backupValue: plan.backupValue,
  });
  if (!committed.ok) {
    if (committed.conflict === 'storage') {
      throw ProblemDetailsError.conflict('迁移所需的 Redis 存储结构异常，未执行任何写入。');
    }
    throw ProblemDetailsError.preconditionFailed(
      '配置在迁移预检后被其它写入修改，未执行任何迁移；请重新运行。',
    );
  }

  const safeFeature = publicDeviceFeatures(plan.device.features).tailscale;
  let auditRecorded = true;
  try {
    await recordEvent({
      op: 'device.tailscale.migrate',
      actor: 'migration',
      target: { kind: 'device', id: plan.device.id, name: plan.device.name },
      before: {
        legacyNode: plan.summary.nodeName,
        legacyGroup: plan.summary.groupName,
        ruleCount: plan.summary.ruleCount,
      },
      after: safeFeature,
      profileId: plan.profileId,
      undoable: false,
    });
  } catch {
    // 数据事务已经提交。审计是后置旁路，失败不能把已成功的迁移谎报成失败，
    // 否则操作者重跑只会看到“没有旧节点”而不知道状态已切换。
    auditRecorded = false;
  }
  return { backupKey: plan.backupKey, auditRecorded };
}
