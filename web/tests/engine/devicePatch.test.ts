import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  MANAGED_PATCH_KEYS,
  REDACTED,
  SENSITIVE_PATCH_KEYS,
  applyDevicePatch,
  assertValidDevicePatch,
  buildDeviceConfig,
  redactRenderedYaml,
  redactSensitive,
  renderDevicePatchedYaml,
  touchesSensitiveKeys,
} from '@/lib/engine/devicePatch';
import { ConfigValidationError } from '@/lib/config/errors';
import { MAX_BASE_PATCH_BYTES, MAX_BASE_PATCH_DEPTH } from '@/schemas';

/* ─── RFC 7386 语义 ─────────────────────────────────────────────────── */

describe('applyDevicePatch — RFC 7386', () => {
  it('deep-merges objects field by field', () => {
    const target = { dns: { enable: true, nameserver: ['1.1.1.1'], 'enhanced-mode': 'fake-ip' } };
    const out = applyDevicePatch(target, { dns: { enable: false } });
    expect(out).toEqual({
      dns: { enable: false, nameserver: ['1.1.1.1'], 'enhanced-mode': 'fake-ip' },
    });
  });

  it('replaces arrays wholesale rather than merging element-wise', () => {
    const out = applyDevicePatch(
      { dns: { nameserver: ['1.1.1.1', '8.8.8.8'] } },
      {
        dns: { nameserver: ['223.5.5.5'] },
      },
    );
    expect(out).toEqual({ dns: { nameserver: ['223.5.5.5'] } });
  });

  it('replaces scalars', () => {
    expect(applyDevicePatch({ 'mixed-port': 7890 }, { 'mixed-port': 7891 })).toEqual({
      'mixed-port': 7891,
    });
  });

  it('deletes a key on null', () => {
    expect(applyDevicePatch({ secret: 'x', mode: 'rule' }, { secret: null })).toEqual({
      mode: 'rule',
    });
  });

  it('deletes a NESTED key on null without touching its siblings', () => {
    const out = applyDevicePatch(
      { dns: { enable: true, listen: '0.0.0.0:53', ipv6: false } },
      { dns: { listen: null } },
    );
    expect(out).toEqual({ dns: { enable: true, ipv6: false } });
  });

  it('is a no-op for a null on a key that does not exist', () => {
    expect(applyDevicePatch({ mode: 'rule' }, { absent: null })).toEqual({ mode: 'rule' });
  });

  it('treats a non-object target side as an empty object when the patch is an object', () => {
    // RFC 7386: 补丁里的对象永远是深合并意图，目标是标量时先视作 {} 再合并。
    expect(applyDevicePatch({ tun: false }, { tun: { enable: true } })).toEqual({
      tun: { enable: true },
    });
  });

  it('creates missing keys', () => {
    expect(applyDevicePatch({}, { 'external-ui': 'ui' })).toEqual({ 'external-ui': 'ui' });
  });

  it('does not mutate the target', () => {
    const target = { dns: { enable: true } };
    const out = applyDevicePatch(target, { dns: { enable: false } });
    expect(target).toEqual({ dns: { enable: true } });
    expect(out).not.toBe(target);
  });

  it('an empty patch is the identity', () => {
    expect(applyDevicePatch({ a: 1, b: { c: 2 } }, {})).toEqual({ a: 1, b: { c: 2 } });
  });
});

/* ─── 静态校验 ──────────────────────────────────────────────────────── */

function issueOf(fn: () => void): ConfigValidationError['issue'] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.issue;
    throw error;
  }
  throw new Error('expected a ConfigValidationError');
}

describe('assertValidDevicePatch', () => {
  it('accepts a plain object patch', () => {
    expect(() => assertValidDevicePatch({ 'mixed-port': 7891 }, 'dev')).not.toThrow();
  });

  it.each([[null], [42], ['str'], [[1, 2]], [undefined]])('rejects a non-object patch: %s', (v) => {
    expect(issueOf(() => assertValidDevicePatch(v, 'dev')).code).toBe('device_patch_not_object');
  });

  it.each(MANAGED_PATCH_KEYS)('rejects the managed key %s', (key) => {
    const issue = issueOf(() => assertValidDevicePatch({ [key]: [] }, 'macbook'));
    expect(issue.code).toBe('device_patch_managed_key');
    expect(issue.path).toBe(`base_patch.${key}`);
    expect(issue.message).toContain('macbook');
  });

  it('rejects a managed key even when it is being deleted', () => {
    // `rules: null` would blow away the shared layer's routing for this device.
    expect(issueOf(() => assertValidDevicePatch({ rules: null }, 'dev')).code).toBe(
      'device_patch_managed_key',
    );
  });

  it('allows a managed key nested under a non-managed top-level key', () => {
    // 黑名单只管顶层 —— 顶层才是补丁的作用域。
    expect(() => assertValidDevicePatch({ profile: { rules: 1 } }, 'dev')).not.toThrow();
  });

  it('rejects a patch over the size limit', () => {
    const big = { notes: 'x'.repeat(MAX_BASE_PATCH_BYTES) };
    expect(issueOf(() => assertValidDevicePatch(big, 'dev')).code).toBe('device_patch_too_large');
  });

  it('accepts a patch just under the size limit', () => {
    const ok = { notes: 'x'.repeat(MAX_BASE_PATCH_BYTES - 64) };
    expect(() => assertValidDevicePatch(ok, 'dev')).not.toThrow();
  });

  it('rejects a patch nested past the depth limit', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < MAX_BASE_PATCH_DEPTH + 2; i += 1) deep = { nest: deep };
    expect(issueOf(() => assertValidDevicePatch(deep, 'dev')).code).toBe('device_patch_too_deep');
  });

  it('accepts a patch exactly at the depth limit', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    // {leaf} 本身是第 1 层，再套 MAX-1 层正好触到上限。
    for (let i = 0; i < MAX_BASE_PATCH_DEPTH - 1; i += 1) deep = { nest: deep };
    expect(() => assertValidDevicePatch(deep, 'dev')).not.toThrow();
  });

  it('counts array nesting toward the depth limit', () => {
    let deep: unknown = 1;
    for (let i = 0; i < MAX_BASE_PATCH_DEPTH + 2; i += 1) deep = [deep];
    expect(issueOf(() => assertValidDevicePatch({ a: deep }, 'dev')).code).toBe(
      'device_patch_too_deep',
    );
  });
});

/* ─── 敏感键 ────────────────────────────────────────────────────────── */

describe('redactSensitive / touchesSensitiveKeys', () => {
  it.each(SENSITIVE_PATCH_KEYS)('masks %s at the top level', (key) => {
    expect(redactSensitive({ [key]: 'real-value' })).toEqual({ [key]: REDACTED });
    expect(touchesSensitiveKeys({ [key]: 'real-value' })).toBe(true);
  });

  it('masks nested and array-nested occurrences', () => {
    const out = redactSensitive({
      listeners: [{ name: 'a', password: 'p1' }, { name: 'b' }],
      deep: { deeper: { secret: 's' } },
    });
    expect(out).toEqual({
      listeners: [{ name: 'a', password: REDACTED }, { name: 'b' }],
      deep: { deeper: { secret: REDACTED } },
    });
    expect(touchesSensitiveKeys({ deep: { deeper: { secret: 's' } } })).toBe(true);
  });

  it('is case-insensitive on the key name', () => {
    expect(redactSensitive({ Secret: 'x', 'AUTH-KEY': 'y' })).toEqual({
      Secret: REDACTED,
      'AUTH-KEY': REDACTED,
    });
  });

  it('leaves non-sensitive data untouched', () => {
    const input = { 'mixed-port': 7890, dns: { nameserver: ['1.1.1.1'] } };
    expect(redactSensitive(input)).toEqual(input);
    expect(touchesSensitiveKeys(input)).toBe(false);
  });

  it('masks the value but never the key itself', () => {
    expect(Object.keys(redactSensitive({ secret: 'x' }))).toEqual(['secret']);
  });
});

/* ─── YAML 合并（最小改动） ─────────────────────────────────────────── */

const SHARED = `# 顶部说明注释
mixed-port: 7890
mode: rule
# dns 段的注释
dns:
  enable: true
  nameserver:
    - 1.1.1.1
proxies: []
proxy-groups: []
rules:
  - MATCH,DIRECT
`;

describe('renderDevicePatchedYaml', () => {
  it('rewrites only the patched key and keeps every comment', () => {
    const out = renderDevicePatchedYaml(SHARED, { 'mixed-port': 7891 });
    expect(out).toContain('# 顶部说明注释');
    expect(out).toContain('# dns 段的注释');
    expect(out).toContain('mixed-port: 7891');
    expect(out).toContain('mode: rule');
  });

  it('is byte-identical to the input for an empty patch (零设备铁律的基石)', () => {
    expect(renderDevicePatchedYaml(SHARED, {})).toBe(SHARED);
  });

  it('deep-merges into an existing block without dropping siblings', () => {
    const out = renderDevicePatchedYaml(SHARED, { dns: { enable: false } });
    expect(out).toContain('enable: false');
    expect(out).toContain('1.1.1.1');
  });

  it('deletes a top-level key on null', () => {
    const out = renderDevicePatchedYaml(SHARED, { mode: null });
    expect(out).not.toContain('mode: rule');
    expect(out).toContain('mixed-port: 7890');
  });

  it('adds a key that the shared render did not have', () => {
    expect(renderDevicePatchedYaml(SHARED, { 'find-process-mode': 'off' })).toContain(
      'find-process-mode: off',
    );
  });
});

/* ─── 全链路：静态 + 结构 + 全量校验 ────────────────────────────────── */

describe('buildDeviceConfig', () => {
  it('produces the patched document when everything checks out', () => {
    const out = buildDeviceConfig(SHARED, { 'mixed-port': 7891, 'external-ui': 'ui' }, 'server');
    expect(out).toContain('mixed-port: 7891');
    expect(out).toContain('external-ui: ui');
  });

  it('runs the static gate first — a managed key never reaches the renderer', () => {
    expect(issueOf(() => buildDeviceConfig(SHARED, { proxies: [] }, 'dev')).code).toBe(
      'device_patch_managed_key',
    );
  });

  it('rejects a patch that breaks the document structure (base 结构校验那一道)', () => {
    // 补丁里塞一个字面 `<<` 键 → 重新解析时是 YAML 合并键，parseBaseDocument
    // 明令禁止（Go 的 loader 会展开它，我们的 AST 不会,两边就此分叉）。
    // 错误必须点名是哪台设备 —— 共享层保存被拦时用户要知道去改谁。
    const issue = issueOf(() => buildDeviceConfig(SHARED, { '<<': { a: 1 } }, 'iphone'));
    expect(issue.section).toBe('devices');
    expect(issue.message).toContain('iphone');
  });

  it('runs the FINAL validator on the merged document', () => {
    // 顶层区块现在全在黑名单里,补丁已经够不到跨区块引用 —— 但最终校验这道门必须
    // 仍然接着,否则一份本就非法的共享产物会被设备链路原样下发。用一份规则指向
    // 不存在策略组的共享文档 + 空补丁来证明它确实在跑。
    const brokenShared = `proxies: []
proxy-groups:
  - {name: 出口, type: select, proxies: [DIRECT]}
rules:
  - MATCH,不存在的组
`;
    const issue = issueOf(() => buildDeviceConfig(brokenShared, {}, 'server'));
    expect(issue.code).toBe('device_patch_final_invalid');
    expect(issue.message).toContain('server');
  });

  it('拒绝 proxy-providers —— 设备不得引入共享层之外的节点来源', () => {
    const issue = issueOf(() =>
      buildDeviceConfig(SHARED, { 'proxy-providers': { extra: { type: 'http' } } }, 'server'),
    );
    expect(issue.code).toBe('device_patch_managed_key');
    expect(issue.path).toBe('base_patch.proxy-providers');
  });

  it('keeps the three gates in order: static → structure → final', () => {
    // 同时踩三道门时，最早的那道先报 —— 用户一次只需要修一个问题。
    expect(issueOf(() => buildDeviceConfig(SHARED, { rules: 'x' }, 'dev')).code).toBe(
      'device_patch_managed_key',
    );
  });

  it('accepts an empty patch and returns the shared document unchanged', () => {
    expect(buildDeviceConfig(SHARED, {}, 'dev')).toBe(SHARED);
  });
});

/* ─── 预览掩码 ──────────────────────────────────────────────────────── */

describe('redactRenderedYaml', () => {
  it('masks top-level, nested and array-nested sensitive values', () => {
    const out = redactRenderedYaml(`secret: super-secret
mixed-port: 7890
dns:
  password: nested-pw
proxies:
  - name: HK-1
    password: node-pw
  - name: HK-2
    auth-key: tskey-abc
`);
    expect(out).not.toContain('super-secret');
    expect(out).not.toContain('nested-pw');
    expect(out).not.toContain('node-pw');
    expect(out).not.toContain('tskey-abc');
    // 键与非敏感值原样保留 —— 掩的是值，不是结构。
    expect(out).toContain('secret: "***"');
    expect(out).toContain('mixed-port: 7890');
    expect(out).toContain('HK-1');
  });

  it('is case-insensitive on the key name', () => {
    const out = redactRenderedYaml('Secret: x\nAUTH-KEY: y\n');
    expect(out).not.toContain('x');
    expect(out).not.toContain('y');
  });

  it('leaves a document with no sensitive keys semantically intact', () => {
    const out = redactRenderedYaml('mixed-port: 7890\ndns:\n  enable: true\n');
    expect(parse(out)).toEqual({ 'mixed-port': 7890, dns: { enable: true } });
  });

  it('returns unparsable or non-mapping input untouched rather than throwing', () => {
    expect(redactRenderedYaml('- just\n- a\n- list\n')).toBe('- just\n- a\n- list\n');
    expect(redactRenderedYaml('key: [unclosed\n')).toBe('key: [unclosed\n');
  });
});
