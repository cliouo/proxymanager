import { describe, expect, it } from 'vitest';
import { actorLabel, describeAuditEvent, groupConsecutive } from '@/lib/ui/auditEventCopy';

describe('describeAuditEvent', () => {
  it('names the subject from the op scope when there is no target', () => {
    expect(describeAuditEvent({ op: 'rule-anchor-append.create', actor: 'web-ui' })).toEqual({
      title: '新增规则',
      tone: 'create',
    });
    expect(describeAuditEvent({ op: 'rule-provider.update', actor: 'web-ui' }).title).toBe(
      '修改规则资源',
    );
  });

  it('wraps reorder verbs around their subject instead of leaking the raw action', () => {
    const e = describeAuditEvent({
      op: 'rules.move',
      actor: 'web-ui',
      target: { kind: 'profile' },
    });
    expect(e).toEqual({ title: '调整分流规则顺序', tone: 'move' });
    expect(describeAuditEvent({ op: 'proxy-groups.reorder', actor: 'web-ui' }).title).toBe(
      '调整策略组顺序',
    );
  });

  it('falls back to the target kind, and keeps self-describing verbs bare', () => {
    expect(
      describeAuditEvent({ op: 'patch', actor: 'admin', target: { kind: 'proxy-group' } }).title,
    ).toBe('修改策略组');
    expect(
      describeAuditEvent({
        op: 'chained-proxy.create-pool-chain',
        actor: 'web-ui',
        target: { kind: 'proxy-group' },
      }).title,
    ).toBe('新建链路');
  });

  it('marks AI-authored and undo events with their own tone', () => {
    expect(describeAuditEvent({ op: 'config-section.set-section', actor: 'ai_chat' })).toEqual({
      title: '设置基础配置',
      tone: 'ai',
    });
    expect(describeAuditEvent({ op: 'rule.update', actor: 'web-ui', undoes: 'evt-1' })).toEqual({
      title: '撤销 · 修改规则',
      tone: 'undo',
    });
  });
});

describe('actorLabel', () => {
  it('translates known actors and passes unknown ones through', () => {
    expect(actorLabel('web-ui')).toBe('网页');
    expect(actorLabel('ai_chat')).toBe('配置助手');
    expect(actorLabel('someone')).toBe('someone');
  });
});

describe('groupConsecutive', () => {
  const ev = (op: string, actor = 'web-ui') => ({ op, actor });

  it('collapses runs of at least three identical op+actor events', () => {
    const out = groupConsecutive([
      ev('rules.move'),
      ev('rules.move'),
      ev('rules.move'),
      ev('rule.create'),
      ev('rules.move'),
      ev('rules.move'),
    ]);
    expect(out.map((x) => (x.kind === 'run' ? `run:${x.events.length}` : 'single'))).toEqual([
      'run:3',
      'single',
      'single',
      'single',
    ]);
  });

  it('does not merge the same op from different actors', () => {
    const out = groupConsecutive([
      ev('rule.update'),
      ev('rule.update', 'ai_chat'),
      ev('rule.update'),
    ]);
    expect(out.every((x) => x.kind === 'single')).toBe(true);
  });
});
