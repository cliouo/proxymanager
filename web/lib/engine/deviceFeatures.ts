import { isMap, isSeq, parseDocument, type Document, type YAMLSeq } from 'yaml';
import { ConfigValidationError } from '@/lib/config/errors';
import {
  RuleCreateSchema,
  ruleLine,
  tailscaleServiceRouteKey,
  type DeviceFeatures,
  type TailscaleDeviceFeature,
} from '@/schemas';

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

/**
 * One instance to render, in stable order: the legacy slot first, then the
 * additional instances in their stored order.
 */
interface RenderableInstance {
  feature: TailscaleDeviceFeature;
  /** Path prefix used in error messages, e.g. `features.tailscaleInstances[0]`. */
  path: string;
  /** True for the original slot, which keeps the historical default names. */
  legacy: boolean;
}

/**
 * Default node / group / state-directory names.
 *
 * The legacy slot keeps its historical defaults (`ts-<hostname>`, group
 * `Tailscale`, state dir `./ts-<hostname>`) byte for byte. Additional instances
 * derive every default from their immutable id instead of their hostname: a
 * hostname can be edited, and an edited hostname must not silently move a
 * running node's state directory or steal another instance's group name.
 */
export function tailscaleDefaultNames(
  feature: TailscaleDeviceFeature,
  legacy: boolean,
): { nodeName: string; groupName: string; stateDir: string } {
  if (legacy) {
    return {
      nodeName: feature.nodeName ?? `ts-${feature.hostname}`,
      groupName: feature.groupName ?? DEFAULT_TAILSCALE_GROUP_NAME,
      stateDir: feature.stateDir ?? `./ts-${feature.hostname}`,
    };
  }
  const suffix = feature.id ?? feature.hostname;
  return {
    nodeName: feature.nodeName ?? `ts-${feature.hostname}`,
    groupName: feature.groupName ?? `${DEFAULT_TAILSCALE_GROUP_NAME}-${suffix}`,
    stateDir: feature.stateDir ?? `./ts-${suffix}`,
  };
}

/** Effective group name for every instance, exposed to callers (UI / MCP / docs). */
export function tailscaleEffectiveGroupName(
  feature: TailscaleDeviceFeature,
  legacy: boolean,
): string {
  return tailscaleDefaultNames(feature, legacy).groupName;
}

function assertNameAvailable(
  proxyNames: ReadonlySet<string>,
  groupNames: ReadonlySet<string>,
  name: string,
  deviceLabel: string,
  kind: '节点' | '策略组',
  path: string,
): void {
  if (!proxyNames.has(name) && !groupNames.has(name)) return;
  throw featureIssue(
    'device_tailscale_name_conflict',
    `设备「${deviceLabel}」的 Tailscale ${kind}名 "${name}" 与共享配置冲突，请换一个名字。`,
    path,
  );
}

/** State directories are host paths: two instances cannot share one. */
function normaliseStateDir(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed === '' ? value.trim() : trimmed;
}

function serviceRouteLines(
  feature: TailscaleDeviceFeature,
  groupName: string,
  deviceLabel: string,
  path: string,
): string[] {
  const routes = feature.serviceRoutes ?? [];
  return routes.map((route, index) => {
    // Exact host route (a /32 or /128) AND the destination port, so a named
    // service reaches this instance while other tailnet traffic keeps its own
    // path. `no-resolve` stays inside the AND payload: mihomo rejects a
    // no-resolve modifier on the logical rule itself, and every value below
    // already passed the strict literal / port schema, so the rendered line
    // cannot smuggle a delimiter.
    const ipv6 = route.ip.includes(':');
    const cidr = `${route.ip}/${ipv6 ? 128 : 32}`;
    const predicate = `((IP-CIDR${ipv6 ? '6' : ''},${cidr},no-resolve),(DST-PORT,${route.port}))`;
    if (/[\u0000-\u001f\u007f]/u.test(predicate)) {
      throw featureIssue(
        'device_tailscale_service_invalid',
        `设备「${deviceLabel}」的 Tailscale 服务路由第 ${index + 1} 条无效（目标 IP + 端口）。`,
        `${path}.serviceRoutes`,
      );
    }
    return `AND,${predicate},${groupName}`;
  });
}

function cidrLines(
  feature: TailscaleDeviceFeature,
  groupName: string,
  deviceLabel: string,
  path: string,
): string[] {
  const cidrs = [...new Set([TAILNET_CIDR, ...feature.extraCidrs])];
  return cidrs.map((cidr) => {
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
        `${path}.extraCidrs`,
      );
    }
    return ruleLine(parsed.data);
  });
}

/**
 * Inject typed device-only features into a patched final document.
 *
 * The function is deliberately pure and byte-identical when no feature is enabled.
 * Tailscale routes are explicit device overrides, so they are inserted at the
 * beginning of the final rule list. Putting them merely before MATCH is not
 * sufficient: an earlier shared IP-CIDR/DIRECT rule could silently shadow the
 * device route while every structural validator still passes.
 *
 * Ordering inside the injected block: exact `IP + port` service rules first
 * (they are the narrowest), then broad tailnet/CIDR rules. A device that mixes
 * a legacy CIDR instance with a service instance therefore still sends a named
 * service to its own instance.
 */
export function emitDeviceFeaturesYaml(
  content: string,
  features: DeviceFeatures,
  deviceLabel: string,
): string {
  const legacyFeature = features.tailscale;
  const additional = features.tailscaleInstances ?? [];
  if (!legacyFeature && additional.length === 0) return content;

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
  const proxyNames = namesIn(proxies);
  const groupNames = namesIn(groups);

  const instances: RenderableInstance[] = [
    ...(legacyFeature
      ? [{ feature: legacyFeature, path: 'features.tailscale', legacy: true }]
      : []),
    ...additional.map((feature, index) => ({
      feature,
      path: `features.tailscaleInstances[${index}]`,
      legacy: false,
    })),
  ];

  const claimedStateDirs = new Map<string, string>();
  const claimedServices = new Map<string, string>();
  const serviceLines: string[] = [];
  const cidrRuleLines: string[] = [];

  for (const { feature, path, legacy } of instances) {
    const { nodeName, groupName, stateDir } = tailscaleDefaultNames(feature, legacy);

    assertNameAvailable(proxyNames, groupNames, nodeName, deviceLabel, '节点', `${path}.nodeName`);
    assertNameAvailable(
      proxyNames,
      groupNames,
      groupName,
      deviceLabel,
      '策略组',
      `${path}.groupName`,
    );
    if (nodeName === groupName) {
      throw featureIssue(
        'device_tailscale_name_conflict',
        `设备「${deviceLabel}」的 Tailscale 节点名与策略组名不能相同。`,
        `${path}.groupName`,
      );
    }

    const stateKey = normaliseStateDir(stateDir);
    const otherStateDir = claimedStateDirs.get(stateKey);
    if (otherStateDir !== undefined) {
      throw featureIssue(
        'device_tailscale_state_dir_conflict',
        `设备「${deviceLabel}」的两个 Tailscale 实例不能使用同一个状态目录 "${stateDir}"。`,
        `${path}.stateDir`,
      );
    }
    claimedStateDirs.set(stateKey, stateDir);

    proxies.add(
      doc.createNode({
        name: nodeName,
        type: 'tailscale',
        hostname: feature.hostname,
        ...(feature.authKey ? { 'auth-key': feature.authKey } : {}),
        ...(feature.controlUrl ? { 'control-url': feature.controlUrl } : {}),
        'state-dir': stateDir,
        ephemeral: feature.ephemeral,
        udp: feature.udp,
        'accept-routes': feature.acceptRoutes,
        ...(feature.exitNode ? { 'exit-node': feature.exitNode } : {}),
        'exit-node-allow-lan-access': feature.exitNodeAllowLanAccess,
      }),
    );
    groups.add(doc.createNode({ name: groupName, type: 'select', proxies: [nodeName] }));
    proxyNames.add(nodeName);
    groupNames.add(groupName);

    if (feature.routeMode === 'service') {
      for (const route of feature.serviceRoutes ?? []) {
        // One destination belongs to exactly one instance on a device. This is
        // also the last line of defence for paths that bypass the service
        // layer's earlier 409 (for example an undo restoring an old snapshot).
        const key = tailscaleServiceRouteKey(route);
        const owner = claimedServices.get(key);
        if (owner !== undefined) {
          throw featureIssue(
            'device_tailscale_service_conflict',
            `设备「${deviceLabel}」的 Tailscale 实例都在使用目标 ${route.ip}:${route.port}；每对「目标 IP + 端口」只能属于一个实例。`,
            `${path}.serviceRoutes`,
          );
        }
        claimedServices.set(key, path);
      }
      serviceLines.push(...serviceRouteLines(feature, groupName, deviceLabel, path));
      continue;
    }
    if (!legacy) {
      // An additional instance has no legacy CIDR behaviour to fall back on:
      // rendering a broad route for it would silently widen traffic.
      throw featureIssue(
        'device_tailscale_service_required',
        `设备「${deviceLabel}」的附加 Tailscale 实例必须使用服务模式并至少配置一条「目标 IP + 端口」。`,
        `${path}.serviceRoutes`,
      );
    }
    cidrRuleLines.push(...cidrLines(feature, groupName, deviceLabel, path));
  }

  const lines = [...serviceLines, ...cidrRuleLines];
  rules.items.splice(0, 0, ...lines.map((line) => doc.createNode(line)));

  return doc.toString();
}
