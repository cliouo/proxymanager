import { describe, expect, it } from 'vitest';
import { compactHistory, isValidConversationId } from '@/lib/ai/session';
import type { ChatMessage } from '@/lib/ai/deepseek';

describe('isValidConversationId', () => {
  it('accepts uuid-like ids, rejects junk', () => {
    expect(isValidConversationId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
    expect(isValidConversationId('short')).toBe(false);
    expect(isValidConversationId('has space and:colon')).toBe(false);
    expect(isValidConversationId('a'.repeat(80))).toBe(false);
  });
});

describe('compactHistory', () => {
  const round = (q: string, big = false): ChatMessage[] => [
    { role: 'user', content: q },
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'think',
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'list_rules', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 't1', content: big ? 'X'.repeat(40_000) : 'small result' },
    { role: 'assistant', content: `answer to ${q}` },
  ];

  it('keeps everything when under budget', () => {
    const msgs = [...round('q1'), ...round('q2')];
    expect(compactHistory(msgs)).toHaveLength(msgs.length);
  });

  it('drops oldest whole rounds when over budget, keeping tool pairs intact', () => {
    const msgs = [...round('q1', true), ...round('q2', true)];
    const out = compactHistory(msgs);
    // oldest round dropped; result starts at a user message
    expect(out[0].role).toBe('user');
    expect(out[0].content).toBe('q2');
    // every tool message still has its preceding tool_call
    const callIds = new Set<string>();
    for (const m of out) {
      if (m.tool_calls) for (const c of m.tool_calls) callIds.add(c.id);
      if (m.role === 'tool' && m.tool_call_id) expect(callIds.has(m.tool_call_id)).toBe(true);
    }
  });

  it('always keeps at least the last round even if it alone exceeds budget', () => {
    const msgs = round('only', true);
    const out = compactHistory(msgs);
    expect(out[0].content).toBe('only');
    expect(out).toHaveLength(msgs.length);
  });
});
