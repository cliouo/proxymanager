import { describe, expect, it } from 'vitest';
import { assertWriteAllowed, NEVER_LIST_ACTIONS, NeverListError } from '@/lib/ai/actions/neverList';
import { listActions } from '@/lib/ai/actions/registry';
import type { ActionDef } from '@/lib/ai/actions/types';

describe('never-list', () => {
  it('no never-listed name is ever registered as an action', () => {
    const registered = new Set(listActions().map((action) => action.name));
    for (const name of NEVER_LIST_ACTIONS) {
      expect(registered.has(name), `"${name}" 出现在 registry 里`).toBe(false);
    }
  });

  it('refuses never-listed writes even if they were registered', () => {
    const fake = { name: 'delete_profile', risk: 'write' } as unknown as ActionDef;
    expect(() => assertWriteAllowed(fake)).toThrow(NeverListError);
  });

  it('keeps read actions off the confirmation path', () => {
    const read = { name: 'list_profiles', risk: 'read' } as unknown as ActionDef;
    expect(() => assertWriteAllowed(read)).toThrow(NeverListError);
  });
});
