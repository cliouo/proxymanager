import { describe, expect, it } from 'vitest';
import { consumeConfirmation } from '@/lib/ai/confirm';
import { getAction, listActions } from '@/lib/ai/actions/registry';
import { actionsToTools } from '@/lib/ai/toolSchema';

describe('action registry → DeepSeek tools', () => {
  it('exposes the expected actions with correct risk levels', () => {
    expect(getAction('search_mihomo_docs')?.risk).toBe('read');
    expect(getAction('get_base_overview')?.risk).toBe('read');
    expect(getAction('list_rules')?.risk).toBe('read');
    expect(getAction('add_rule')?.risk).toBe('write');
    expect(getAction('update_rule')?.risk).toBe('write');
    expect(getAction('delete_rule')?.risk).toBe('write');
  });

  it('generates a valid function tool schema for every action (incl. refined inputs)', () => {
    const tools = actionsToTools(listActions());
    expect(tools.length).toBe(listActions().length);
    for (const tool of tools) {
      expect(tool.type).toBe('function');
      expect(typeof tool.function.name).toBe('string');
      expect(tool.function.description.length).toBeGreaterThan(0);
      // parameters must be a JSON-Schema object with no dialect marker.
      expect(tool.function.parameters).toMatchObject({ type: 'object' });
      expect(tool.function.parameters.$schema).toBeUndefined();
    }
    const names = tools.map((t) => t.function.name).sort();
    expect(names).toContain('add_rule');
    expect(names).toContain('search_mihomo_docs');
  });
});

describe('confirmation token guard', () => {
  it('rejects malformed tokens without touching Redis', async () => {
    await expect(consumeConfirmation('not-a-valid-token')).resolves.toBeNull();
    await expect(consumeConfirmation('')).resolves.toBeNull();
  });
});
