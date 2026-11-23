import { defaultFilter } from 'cmdk';
import { describe, expect, it } from 'vitest';
import { namingCommand } from '@/ui/shell/naming-command';

describe('naming palette commands', () => {
  it.each(['source', 'pool'])('matches displayed order for %s names', (kind) => {
    const command = namingCommand('东京', [kind, 'entity-id', 'airport-alias']);
    expect(command.label).toBe('智能命名 · 东京');
    expect(command.value.startsWith(command.label)).toBe(true);
    expect(defaultFilter(command.value, '智能命名 东京')).toBeGreaterThan(0);
    expect(defaultFilter(command.value, 'airport-alias')).toBeGreaterThan(0);
    expect(defaultFilter(command.value, '智能命名 不存在')).toBe(0);
  });
});
