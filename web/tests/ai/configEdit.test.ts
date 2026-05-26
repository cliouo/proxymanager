import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';
import { deleteValueAt, parseYamlValue, setValueAt } from '@/lib/ai/configEdit';
import { assertEditablePath, parsePath } from '@/lib/ai/configPath';

const SRC = `# top comment — must survive edits
mode: rule
dns:
  enable: true
  enhanced-mode: redir-host
proxy-groups:
  - name: OpenAI
    type: select
    proxies: [HK-1, DIRECT]
  - name: 香港
    type: url-test
    proxies: [HK-1]
`;

const fresh = () => parseDocument(SRC);

describe('parseYamlValue', () => {
  it('parses YAML scalars with native typing', () => {
    expect(parseYamlValue('fake-ip')).toBe('fake-ip');
    expect(parseYamlValue('true')).toBe(true);
    expect(parseYamlValue('7890')).toBe(7890);
  });
});

describe('setValueAt', () => {
  it('replaces an existing scalar and preserves unrelated comments', () => {
    const doc = fresh();
    const { before } = setValueAt(doc, parsePath('dns.enhanced-mode'), 'fake-ip');
    expect(before).toBe('redir-host');
    expect(doc.getIn(['dns', 'enhanced-mode'])).toBe('fake-ip');
    expect(doc.toString()).toContain('# top comment');
  });

  it('creates a new map key (before is undefined)', () => {
    const doc = fresh();
    const { before } = setValueAt(doc, parsePath('dns.fallback'), ['8.8.8.8']);
    expect(before).toBeUndefined();
    expect(doc.getIn(['dns', 'fallback', 0])).toBe('8.8.8.8');
  });

  it('appends a new named sequence item', () => {
    const doc = fresh();
    const { before } = setValueAt(doc, parsePath('proxy-groups[New]'), {
      name: 'New',
      type: 'select',
      proxies: ['DIRECT'],
    });
    expect(before).toBeUndefined();
    const groups = doc.toJS()['proxy-groups'] as Array<{ name: string }>;
    expect(groups.map((g) => g.name)).toEqual(['OpenAI', '香港', 'New']);
  });

  it('replaces an existing named sequence item and returns its prior value', () => {
    const doc = fresh();
    const { before } = setValueAt(doc, parsePath('proxy-groups[OpenAI]'), {
      name: 'OpenAI',
      type: 'select',
      proxies: ['香港', 'DIRECT'],
    });
    expect(before).toMatchObject({ name: 'OpenAI', type: 'select' });
    const og = (doc.toJS()['proxy-groups'] as Array<{ name: string; proxies: string[] }>).find(
      (g) => g.name === 'OpenAI',
    );
    expect(og?.proxies).toEqual(['香港', 'DIRECT']);
  });
});

describe('deleteValueAt', () => {
  it('removes a named item and returns it', () => {
    const doc = fresh();
    const { before } = deleteValueAt(doc, parsePath('proxy-groups[香港]'));
    expect(before).toMatchObject({ name: '香港' });
    const names = (doc.toJS()['proxy-groups'] as Array<{ name: string }>).map((g) => g.name);
    expect(names).toEqual(['OpenAI']);
  });

  it('throws when the path does not exist', () => {
    const doc = fresh();
    expect(() => deleteValueAt(doc, parsePath('proxy-groups[NoSuch]'))).toThrow();
  });
});

describe('assertEditablePath (Never-List)', () => {
  it('forbids editing node sources and credentials', () => {
    expect(() => assertEditablePath(parsePath('proxies'))).toThrow();
    expect(() => assertEditablePath(parsePath('proxy-providers[sub-store]'))).toThrow();
    expect(() => assertEditablePath(parsePath('dns.password'))).toThrow();
  });

  it('forbids editing rules via config-section (rule actions own them)', () => {
    expect(() => assertEditablePath(parsePath('rules'))).toThrow();
    expect(() => assertEditablePath(parsePath('rules[0]'))).toThrow();
  });

  it('allows policy/behaviour blocks', () => {
    expect(() => assertEditablePath(parsePath('dns.enhanced-mode'))).not.toThrow();
    expect(() => assertEditablePath(parsePath('proxy-groups[OpenAI]'))).not.toThrow();
  });
});
