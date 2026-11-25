import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import { checkServer, mount } from '@ui-sdk/core/testing';
import { createAgent } from '@ui-sdk/react/agent';
import { createParts } from '@ui-sdk/react/primitive';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DataView } from '@/ui/agent';
import { dataView } from '@/ui/agent/data-view';
import { codeDocument } from '@/ui/editor/code-document';
import { SaveBar } from '@/ui/shell/page';

let allowConfirm = false;
const agent = createAgent({
  allow: (step) => !step.confirm || allowConfirm,
});

const { Root: CodeDocumentRoot } = createParts(codeDocument, { root: 'div' });

afterEach(() => {
  allowConfirm = false;
});

function CodeDocumentHarness({ readOnly = false }: { readOnly?: boolean }) {
  const [text, setText] = useState('proxies:\n  - name: HK-01');
  return (
    <div>
      <CodeDocumentRoot
        aria-label="节点 YAML"
        value={text}
        readOnly={readOnly}
        onValueChange={(next) => setText(next)}
      />
      <output data-testid="code-value">{text}</output>
    </div>
  );
}

describe('custom ui-sdk data primitives (DataView & CodeDocument) and SaveBar', () => {
  test('dataView renders on server and exposes items via mount', () => {
    const items = [{ value: '1', label: 'HK-01' }];
    checkServer(dataView, { summary: '1 个节点', items }, '<root></root>');
    const view = mount(dataView, { summary: '1 个节点', items }, '<root></root>');
    try {
      expect(view.state.summary).toBe('1 个节点');
      expect(view.api.getItems()).toEqual(items);
    } finally {
      view.unmount();
    }
  });

  test('codeDocument renders on server and updates value via api unless readOnly', () => {
    checkServer(codeDocument, { value: 'proxies: []' }, '<root></root>');
    const view = mount(codeDocument, { value: 'proxies: []', readOnly: false }, '<root></root>');
    try {
      expect(view.api.setValue('proxies:\n  - name: A')).toBe(true);
      expect(view.changes.at(-1)).toMatchObject({ key: 'value', value: 'proxies:\n  - name: A' });
    } finally {
      view.unmount();
    }
    const ro = mount(codeDocument, { value: 'locked', readOnly: true }, '<root></root>');
    try {
      expect(ro.api.setValue('changed')).toBe(false);
      expect(ro.state.value).toBe('locked');
    } finally {
      ro.unmount();
    }
  });

  test('DataView exposes summary and items to snapshot and supports paginated/filtered query', async () => {
    const items = Array.from({ length: 65 }, (_, i) => ({
      value: `n-${i + 1}`,
      label: i % 2 === 0 ? `🇯🇵 日本节点 ${i + 1}` : `🇭🇰 香港节点 ${i + 1}`,
    }));

    render(
      <DataView label="节点列表" summary="共 65 个节点" items={items}>
        <ul>
          {items.slice(0, 3).map((item) => (
            <li key={item.value}>{item.label}</li>
          ))}
        </ul>
      </DataView>,
    );

    const entry = agent.snapshot().find((e) => !e.offPage && e.label === '节点列表');
    expect(entry).toBeTruthy();
    expect(entry?.summary).toBe('共 65 个节点');
    expect(entry?.more).toBe(65);
    expect(entry?.actions).toEqual([]);

    const firstPage = await agent.query({ within: '节点列表' });
    expect(Array.isArray(firstPage)).toBe(true);
    if (!Array.isArray(firstPage)) throw new Error(firstPage.error);
    expect(firstPage[0]?.items?.length).toBe(50);
    expect(firstPage[0]?.more).toBe(15);

    const secondPage = await agent.query({ within: '节点列表', from: 50 });
    expect(Array.isArray(secondPage)).toBe(true);
    if (!Array.isArray(secondPage)) throw new Error(secondPage.error);
    expect(secondPage[0]?.items?.length).toBe(15);

    const filtered = await agent.query({ within: '节点列表', text: '日本' });
    expect(Array.isArray(filtered)).toBe(true);
    if (!Array.isArray(filtered)) throw new Error(filtered.error);
    expect(filtered[0]?.items?.every((item) => item.label.includes('日本'))).toBe(true);
  });

  test('CodeDocument lets agent read and update writable YAML and refuses readOnly edits', async () => {
    const { rerender } = render(<CodeDocumentHarness />);

    const entry = agent.snapshot().find((e) => !e.offPage && e.label === '节点 YAML');
    expect(entry?.value).toBe('proxies:\n  - name: HK-01');
    expect(entry?.actions).toContain('setValue');

    const updated = await agent.act({
      steps: [{ ref: '节点 YAML', action: 'setValue', args: ['proxies:\n  - name: JP-01'] }],
    });
    expect(updated.ok, updated.error?.message).toBe(true);
    expect(screen.getByTestId('code-value').textContent).toBe('proxies:\n  - name: JP-01');

    rerender(<CodeDocumentHarness readOnly />);
    const refused = await agent.act({
      steps: [{ ref: '节点 YAML', action: 'setValue', args: ['proxies: []'] }],
    });
    expect(refused.ok).toBe(false);
    expect(screen.getByTestId('code-value').textContent).toBe('proxies:\n  - name: JP-01');
  });

  test('SaveBar gates save button with data-agent-confirm while discard runs freely', async () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    render(
      <SaveBar
        visible
        onSave={onSave}
        onDiscard={onDiscard}
        confirmHint="保存订阅源设置"
      />,
    );

    const discardRes = await agent.act({
      steps: [{ ref: '放弃', action: 'press' }],
    });
    expect(discardRes.ok, discardRes.error?.message).toBe(true);
    expect(onDiscard).toHaveBeenCalledTimes(1);

    allowConfirm = false;
    const denied = await agent.act({
      steps: [{ ref: '保存', action: 'press' }],
    });
    expect(denied.ok).toBe(false);
    expect(onSave).not.toHaveBeenCalled();

    allowConfirm = true;
    const approved = await agent.act({
      steps: [{ ref: '保存', action: 'press' }],
    });
    expect(approved.ok, approved.error?.message).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
