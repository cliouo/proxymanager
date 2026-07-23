/**
 * 新建向导的预设与 /base 反向标注的纯计算部分。
 * 组件本身（.tsx）不进 vitest 收集范围，逻辑落在 .ts 才测得到。
 */

import { describe, expect, it } from 'vitest';
import {
  DEVICE_PRESETS,
  buildPresetPatch,
  overridesByTopLevelKey,
  randomSecret,
  topLevelKeyLines,
} from '@/lib/profiles/devicePresets';

describe('设备类型预设', () => {
  it('offers server / phone / desktop / custom', () => {
    expect(DEVICE_PRESETS.map((p) => p.id)).toEqual(['server', 'phone', 'desktop', 'custom']);
  });

  it('服务器预设开控制器并现生成随机 secret', () => {
    const preset = DEVICE_PRESETS.find((p) => p.id === 'server')!;
    const a = buildPresetPatch(preset);
    const b = buildPresetPatch(preset);
    expect(a['external-controller']).toBe('0.0.0.0:9090');
    expect(typeof a.secret).toBe('string');
    // 每次都是新密钥 —— 两台服务器不该共用一把。
    expect(a.secret).not.toBe(b.secret);
  });

  it('手机预设只关进程匹配', () => {
    const preset = DEVICE_PRESETS.find((p) => p.id === 'phone')!;
    expect(buildPresetPatch(preset)).toEqual({ 'find-process-mode': 'off' });
  });

  it('桌面 / 自定义预设是空补丁', () => {
    for (const id of ['desktop', 'custom']) {
      expect(buildPresetPatch(DEVICE_PRESETS.find((p) => p.id === id)!)).toEqual({});
    }
  });

  it('预设不共享可变状态(改一份补丁不污染下一次)', () => {
    const preset = DEVICE_PRESETS.find((p) => p.id === 'phone')!;
    const first = buildPresetPatch(preset);
    first['find-process-mode'] = 'always';
    expect(buildPresetPatch(preset)).toEqual({ 'find-process-mode': 'off' });
  });

  it('randomSecret 是十六进制且长度稳定', () => {
    expect(randomSecret(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomSecret()).not.toBe(randomSecret());
  });
});

describe('overridesByTopLevelKey', () => {
  it('maps each top-level key to the devices overriding it', () => {
    const map = overridesByTopLevelKey([
      { name: 'macbook', base_patch: { 'mixed-port': 1, secret: 'x' } },
      { name: 'iphone', base_patch: { 'mixed-port': 2 } },
    ]);
    expect(map.get('mixed-port')).toEqual(['macbook', 'iphone']);
    expect(map.get('secret')).toEqual(['macbook']);
  });

  it('零设备 / 空补丁 → 空表(徽章整块不渲染)', () => {
    expect(overridesByTopLevelKey([]).size).toBe(0);
    expect(overridesByTopLevelKey([{ name: 'a', base_patch: {} }]).size).toBe(0);
  });
});

describe('topLevelKeyLines', () => {
  it('locates top-level keys and ignores nested ones', () => {
    const lines = topLevelKeyLines('mixed-port: 7890\ndns:\n  enable: true\nmode: rule\n');
    expect(lines.get('mixed-port')).toBe(1);
    expect(lines.get('dns')).toBe(2);
    expect(lines.get('mode')).toBe(4);
    expect(lines.has('enable')).toBe(false);
  });

  it('keeps the FIRST occurrence of a repeated key', () => {
    expect(topLevelKeyLines('mode: rule\nmode: global\n').get('mode')).toBe(1);
  });
});
