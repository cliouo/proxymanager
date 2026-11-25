import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAgent } from '@ui-sdk/react/agent';
import { describe, expect, test } from 'vitest';
import { Combobox, Field, MultiCombobox, TagInput } from '@/ui/primitives';

const agent = createAgent();

function ComboHarness() {
  const [policy, setPolicy] = useState<string | null>('DIRECT');
  const [groups, setGroups] = useState<string[]>(['hk']);
  const [tags, setTags] = useState<string[]>(['CN']);

  return (
    <div>
      <Field label="目标策略">
        {(id) => (
          <Combobox
            id={id}
            label="目标策略"
            value={policy}
            onChange={setPolicy}
            allowCustom
            options={[
              { value: 'DIRECT', label: '直连', group: '内置' },
              { value: 'PROXY', label: '节点选择', group: '策略组' },
              { value: 'REJECT', label: '拦截', group: '内置' },
            ]}
          />
        )}
      </Field>
      <MultiCombobox
        label="适用策略组"
        value={groups}
        onChange={setGroups}
        options={[
          { value: 'hk', label: '香港节点' },
          { value: 'jp', label: '日本节点' },
          { value: 'us', label: '美国节点' },
        ]}
      />
      <TagInput value={tags} onChange={setTags} aria-label="匹配标签" />
      <output data-testid="combo-state">{JSON.stringify({ policy, groups, tags })}</output>
    </div>
  );
}

describe('ui-sdk migrated Combobox, MultiCombobox, and TagInput', () => {
  test('agent can query options and update Combobox, MultiCombobox, and TagInput', async () => {
    render(<ComboHarness />);

    const components = agent
      .snapshot()
      .filter((entry) => !entry.offPage && entry.component !== 'more');

    for (const entry of components) {
      expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
    }

    const choices = await agent.query({ within: '目标策略' });
    expect(Array.isArray(choices)).toBe(true);
    if (!Array.isArray(choices)) throw new Error(choices.error);
    expect(choices[0]?.items?.map((i) => i.label)).toEqual(['直连', '节点选择', '拦截']);

    const result = await agent.act({
      steps: [
        { ref: '目标策略', action: 'setValue', args: ['节点选择'] },
        { ref: '适用策略组', action: 'setValue', args: [['香港节点', '日本节点']] },
        { ref: '匹配标签', action: 'setValue', args: ['JP'] },
        { ref: '添加标签', action: 'press' },
      ],
    });
    expect(result.ok, result.error?.message).toBe(true);

    const state = JSON.parse(screen.getByTestId('combo-state').textContent || '{}');
    expect(state).toEqual({
      policy: 'PROXY',
      groups: ['hk', 'jp'],
      tags: ['CN', 'JP'],
    });
  });

  test('TagInput adds tags with Enter and removes via chip button', async () => {
    const user = userEvent.setup();
    render(<ComboHarness />);

    const input = screen.getByLabelText('匹配标签');
    await user.type(input, 'SG{Enter}');
    expect(JSON.parse(screen.getByTestId('combo-state').textContent || '{}').tags).toEqual(['CN', 'SG']);

    await user.click(screen.getByRole('button', { name: '移除 CN' }));
    expect(JSON.parse(screen.getByTestId('combo-state').textContent || '{}').tags).toEqual(['SG']);
  });
});
