import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAgent } from '@ui-sdk/react/agent';
import { describe, expect, test, vi } from 'vitest';
import {
  Button,
  Checkbox,
  Field,
  Input,
  SearchInput,
  SegmentedControl,
  Select,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
} from '@/ui/primitives';

const agent = createAgent();

function FormHarness({ onSubmitClick }: { onSubmitClick: () => void }) {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [region, setRegion] = useState<'hk' | 'jp' | 'us'>('hk');
  const [tab, setTab] = useState('nodes');

  return (
    <div>
      <Field label="订阅名称">
        {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="备注信息">
        {(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} />}
      </Field>
      <SearchInput value={search} onChange={setSearch} aria-label="筛选节点" />
      <Switch checked={enabled} onCheckedChange={setEnabled} label="自动更新" />
      <Checkbox checked={agreed} onCheckedChange={setAgreed} label="保留旧节点" />
      <SegmentedControl
        label="同步模式"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'auto', label: '自动' },
          { value: 'manual', label: '手动' },
        ]}
      />
      <Field label="首选区域">
        {(id) => (
          <Select
            id={id}
            value={region}
            onValueChange={setRegion}
            options={[
              { value: 'hk', label: '香港' },
              { value: 'jp', label: '日本' },
              { value: 'us', label: '美国' },
            ]}
          />
        )}
      </Field>
      <Tabs
        label="详情分组"
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'nodes', label: '节点列表' },
          { value: 'settings', label: '高级设置' },
        ]}
      >
        <TabPanel value="nodes" forceMount>
          节点内容
        </TabPanel>
        <TabPanel value="settings" forceMount>
          设置内容
        </TabPanel>
      </Tabs>
      <Button variant="primary" onClick={onSubmitClick}>
        保存设置
      </Button>
      <Button asChild variant="ghost">
        <a href="#sources">查看全部订阅</a>
      </Button>
      <output data-testid="state">
        {JSON.stringify({ name, notes, search, enabled, agreed, mode, region, tab })}
      </output>
    </div>
  );
}

describe('ui-sdk migrated form & control primitives', () => {
  test('agent can discover every control by name and update all values', async () => {
    const onSubmit = vi.fn();
    render(<FormHarness onSubmitClick={onSubmit} />);

    const components = agent
      .snapshot()
      .filter((entry) => !entry.offPage && entry.component !== 'more');

    for (const entry of components) {
      expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
    }

    const labels = components.map((entry) => entry.label);
    for (const expected of [
      '订阅名称',
      '备注信息',
      '筛选节点',
      '自动更新',
      '保留旧节点',
      '同步模式',
      '首选区域',
      '详情分组',
      '保存设置',
      '查看全部订阅',
    ]) {
      expect(labels, `${expected} is missing from snapshot`).toContain(expected);
    }

    const regionChoices = await agent.query({ within: '首选区域' });
    expect(Array.isArray(regionChoices)).toBe(true);
    if (!Array.isArray(regionChoices)) throw new Error(regionChoices.error);
    expect(regionChoices[0]?.items?.map((i) => i.label)).toEqual(['香港', '日本', '美国']);

    const result = await agent.act({
      steps: [
        { ref: '订阅名称', action: 'setValue', args: ['机场主线'] },
        { ref: '备注信息', action: 'setValue', args: ['主力节点池'] },
        { ref: '筛选节点', action: 'setValue', args: ['日本'] },
        { ref: '自动更新', action: 'setChecked', args: [true] },
        { ref: '保留旧节点', action: 'setChecked', args: [true] },
        { ref: '同步模式', action: 'setValue', args: ['手动'] },
        { ref: '首选区域', action: 'setValue', args: ['日本'] },
        { ref: '详情分组', action: 'setValue', args: ['高级设置'] },
        { ref: '保存设置', action: 'press' },
      ],
    });
    expect(result.ok, result.error?.message).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    const state = JSON.parse(screen.getByTestId('state').textContent || '{}');
    expect(state).toEqual({
      name: '机场主线',
      notes: '主力节点池',
      search: '日本',
      enabled: true,
      agreed: true,
      mode: 'manual',
      region: 'jp',
      tab: 'settings',
    });
  });

  test('keyboard interaction works for switch, checkbox, segmented control, and tabs', async () => {
    const user = userEvent.setup();
    render(<FormHarness onSubmitClick={() => {}} />);

    const sw = screen.getByRole('switch', { name: '自动更新' });
    sw.focus();
    await user.keyboard(' ');
    expect(sw.getAttribute('aria-checked')).toBe('true');

    const cb = screen.getByRole('checkbox', { name: '保留旧节点' });
    cb.focus();
    await user.keyboard(' ');
    expect(cb.getAttribute('aria-checked')).toBe('true');

    const autoRadio = screen.getByRole('radio', { name: '自动' });
    autoRadio.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: '手动' }).getAttribute('aria-checked')).toBe('true');

    const firstTab = screen.getByRole('tab', { name: '节点列表' });
    firstTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '高级设置' }).getAttribute('aria-selected')).toBe('true');
  });
});
