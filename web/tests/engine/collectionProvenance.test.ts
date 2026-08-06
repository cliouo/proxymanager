import { describe, expect, it } from 'vitest';
import { applyOperatorsToCandidates } from '@/lib/engine/resolve';
import type { Operator } from '@/schemas/operator';

function nodeName(node: unknown): string {
  return node !== null && typeof node === 'object' && 'name' in node
    ? String((node as { name: unknown }).name)
    : '';
}

/**
 * Normal-render provenance parity (Delivery finding 3): the collection
 * resolution path must feed the rename-template operator the DISPLAY label
 * (display_name) — not the slug — with the stable source key kept for alias
 * overrides, and the key/label must survive every pipeline transform.
 */

function renameTemplate(over: Record<string, unknown> = {}): Operator {
  return {
    id: 'rt-1',
    kind: 'rename-template',
    template:
      '${emoji} ${region}${?route: · ${route}}${?vendor: · ${vendor}}${?rate: · ${rate}}${?note: · ${note}}${?source: · ${source}}${?index: · ${index}}',
    recognitionRules: [],
    ...over,
  } as Operator;
}

describe('collection resolution provenance (normal render path)', () => {
  it('renders display_name, not slug, when no override exists', () => {
    const candidates = [
      {
        node: { name: '香港 01', type: 'ss' },
        name: '香港 01',
        fromSub: 'airport-a',
        fromSubLabel: '机场A',
      },
      {
        node: { name: '日本 01', type: 'ss' },
        name: '日本 01',
        fromSub: 'airport-b',
        fromSubLabel: '机场B',
      },
    ];
    const out = applyOperatorsToCandidates(candidates, [renameTemplate()]);
    expect(out.map((c) => nodeName(c.node))).toEqual([
      '🇭🇰 香港 · 机场A · 01',
      '🇯🇵 日本 · 机场B · 01',
    ]);
    // stable key survives alongside the label for downstream bindings
    expect(out.map((c) => c.fromSub)).toEqual(['airport-a', 'airport-b']);
  });

  it('sourceAliases keyed by the STABLE key override the display label', () => {
    const candidates = [
      {
        node: { name: '香港 01', type: 'ss' },
        name: '香港 01',
        fromSub: 'airport-a',
        fromSubLabel: '机场A',
      },
    ];
    const out = applyOperatorsToCandidates(candidates, [
      renameTemplate({ sourceAliases: { 'airport-a': '改名机场' } }),
    ]);
    expect(nodeName(out[0].node)).toBe('🇭🇰 香港 · 改名机场 · 01');
    expect(nodeName(out[0].node)).not.toContain('机场A');
  });

  it('provenance survives every pipeline transform (rename/filter/sort)', () => {
    const candidates = [
      {
        node: { name: '香港 01', type: 'ss' },
        name: '香港 01',
        fromSub: 'airport-a',
        fromSubLabel: '机场A',
      },
      {
        node: { name: '日本 01', type: 'ss' },
        name: '日本 01',
        fromSub: 'airport-b',
        fromSubLabel: '机场B',
      },
      {
        node: { name: 'US 01', type: 'ss' },
        name: 'US 01',
        fromSub: 'airport-a',
        fromSubLabel: '机场A',
      },
    ];
    const out = applyOperatorsToCandidates(candidates, [
      renameTemplate(),
      { id: 'f', kind: 'filter-regex', mode: 'keep', pattern: '🇭🇰|🇯🇵' } as Operator,
      { id: 's', kind: 'sort', by: 'name', order: 'desc' } as Operator,
    ]);
    expect(out.map((c) => nodeName(c.node))).toEqual([
      '🇯🇵 日本 · 机场B · 01',
      '🇭🇰 香港 · 机场A · 01',
    ]);
    expect(out.map((c) => c.fromSub)).toEqual(['airport-b', 'airport-a']);
  });
});
