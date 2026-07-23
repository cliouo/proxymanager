import { isMap, isSeq, parseDocument, type Document, type YAMLSeq } from 'yaml';
import { ConfigValidationError } from '@/lib/config/errors';
import { RuleCreateSchema, ruleLine, type DeviceFeatures } from '@/schemas';

export const TAILNET_CIDR = '100.64.0.0/10';
export const DEFAULT_TAILSCALE_GROUP_NAME = 'Tailscale';

function featureIssue(code: string, message: string, path: string): ConfigValidationError {
  return new ConfigValidationError({
    code,
    message,
    section: 'devices',
    path,
    resource: 'device-feature',
  });
}

function sequence(doc: Document, key: string): YAMLSeq {
  const current = doc.get(key, true);
  if (current == null) {
    const created = doc.createNode([]);
    doc.set(key, created);
    return doc.get(key, true) as YAMLSeq;
  }
  if (!isSeq(current)) {
    throw featureIssue(
      'device_feature_section_invalid',
      `设备功能无法注入：最终配置的 "${key}" 不是列表。`,
      key,
    );
  }
  return current;
}

function namesIn(seq: YAMLSeq): Set<string> {
  const names = new Set<string>();
  for (const item of seq.items) {
    if (isMap(item) && typeof item.get('name') === 'string') {
      names.add(String(item.get('name')));
    }
  }
  return names;
}

function hasLegacyTailscale(seq: YAMLSeq): boolean {
  return seq.items.some((item) => isMap(item) && item.get('type') === 'tailscale');
}

function assertNameAvailable(
  proxyNames: ReadonlySet<string>,
  groupNames: ReadonlySet<string>,
  name: string,
  deviceLabel: string,
  kind: '节点' | '策略组',
): void {
  if (!proxyNames.has(name) && !groupNames.has(name)) return;
  throw featureIssue(
    'device_tailscale_name_conflict',
    `设备「${deviceLabel}」的 Tailscale ${kind}名 "${name}" 与共享配置冲突，请换一个名字。`,
    `features.tailscale.${kind === '节点' ? 'nodeName' : 'groupName'}`,
  );
}

/**
 * Inject typed device-only features into a patched final document.
 *
 * The function is deliberately pure and byte-identical when no feature is enabled.
 * Tailscale routes are explicit device overrides, so they are inserted at the
 * beginning of the final rule list. Putting them merely before MATCH is not
 * sufficient: an earlier shared IP-CIDR/DIRECT rule could silently shadow the
 * device route while every structural validator still passes.
 */
export function emitDeviceFeaturesYaml(
  content: string,
  features: DeviceFeatures,
  deviceLabel: string,
): string {
  const tailscale = features.tailscale;
  if (!tailscale) return content;

  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    throw featureIssue(
      'device_feature_shared_unparsable',
      `设备「${deviceLabel}」的共享渲染产物不是合法 YAML。`,
      '$',
    );
  }

  const proxies = sequence(doc, 'proxies');
  if (hasLegacyTailscale(proxies)) {
    throw featureIssue(
      'device_tailscale_legacy_conflict',
      `设备「${deviceLabel}」无法启用 Tailscale：配置文件仍含旧版共享接入，请先迁移到具体设备。`,
      'features.tailscale',
    );
  }

  const groups = sequence(doc, 'proxy-groups');
  const rules = sequence(doc, 'rules');
  const nodeName = tailscale.nodeName ?? `ts-${tailscale.hostname}`;
  const groupName = tailscale.groupName ?? DEFAULT_TAILSCALE_GROUP_NAME;
  const proxyNames = namesIn(proxies);
  const groupNames = namesIn(groups);

  assertNameAvailable(proxyNames, groupNames, nodeName, deviceLabel, '节点');
  assertNameAvailable(proxyNames, groupNames, groupName, deviceLabel, '策略组');
  if (nodeName === groupName) {
    throw featureIssue(
      'device_tailscale_name_conflict',
      `设备「${deviceLabel}」的 Tailscale 节点名与策略组名不能相同。`,
      'features.tailscale.groupName',
    );
  }

  proxies.add(
    doc.createNode({
      name: nodeName,
      type: 'tailscale',
      hostname: tailscale.hostname,
      ...(tailscale.authKey ? { 'auth-key': tailscale.authKey } : {}),
      ...(tailscale.controlUrl ? { 'control-url': tailscale.controlUrl } : {}),
      'state-dir': tailscale.stateDir ?? `./ts-${tailscale.hostname}`,
      ephemeral: tailscale.ephemeral,
      udp: tailscale.udp,
      'accept-routes': tailscale.acceptRoutes,
      ...(tailscale.exitNode ? { 'exit-node': tailscale.exitNode } : {}),
      'exit-node-allow-lan-access': tailscale.exitNodeAllowLanAccess,
    }),
  );
  groups.add(doc.createNode({ name: groupName, type: 'select', proxies: [nodeName] }));

  const cidrs = [...new Set([TAILNET_CIDR, ...tailscale.extraCidrs])];
  const lines = cidrs.map((cidr) => {
    const parsed = RuleCreateSchema.safeParse({
      anchor: 'device-feature',
      type: cidr.includes(':') ? 'IP-CIDR6' : 'IP-CIDR',
      value: cidr,
      policy: groupName,
      options: ['no-resolve'],
      source: 'manual',
      note: 'device-tailscale',
    });
    if (!parsed.success) {
      throw featureIssue(
        'device_tailscale_cidr_invalid',
        `设备「${deviceLabel}」的 Tailscale 路由含无效 CIDR。`,
        'features.tailscale.extraCidrs',
      );
    }
    return ruleLine(parsed.data);
  });
  rules.items.splice(0, 0, ...lines.map((line) => doc.createNode(line)));

  return doc.toString();
}
