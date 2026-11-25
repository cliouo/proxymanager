import { describe, expect, it } from 'vitest';
import { namingCommand } from '@/ui/shell/naming-command';

describe('naming palette commands', () => {
  it.each(['source', 'pool'])('builds label and searchable value for %s names', (kind) => {
    const command = namingCommand('东京', [kind, 'entity-id', 'airport-alias']);
    expect(command.label).toBe('智能命名 · 东京');
    expect(command.value.startsWith(command.label)).toBe(true);
    expect(command.value).toContain('naming');
    expect(command.value).toContain(kind);
    expect(command.value).toContain('airport-alias');
  });
});
