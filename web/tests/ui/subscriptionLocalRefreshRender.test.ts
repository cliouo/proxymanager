import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(
  new URL('../../app/(authed)/subscriptions/page.tsx', import.meta.url),
  'utf8',
);
const cssSource = readFileSync(
  new URL('../../app/(authed)/subscriptions/subscriptions.module.css', import.meta.url),
  'utf8',
);
const addFormStart = pageSource.indexOf('function AddForm(');
const editFormStart = pageSource.indexOf('function EditForm(', addFormStart);
const addFormSource = pageSource.slice(addFormStart, editFormStart);

describe('subscription local refresh interaction', () => {
  it('keeps one task panel with paste, UTF-8 file and one preferred local-fetch action', () => {
    expect(pageSource).toContain('从本机更新');
    expect(pageSource).toContain('选择文件');
    expect(pageSource).toContain('本机拉取');
    expect(pageSource).toContain('data-pm-local-refresh-id');
    expect(pageSource).not.toContain('必须安装扩展');
  });

  it('maps both parent leases to row, page, drawer, navigation and editor barriers', () => {
    expect(pageSource).toContain('createManualRefreshOperationController');
    expect(pageSource).toContain('createAddFormMutationController');
    expect(pageSource).toContain(
      'const globalMutationBusy = manualOperation !== null || addFormOperation !== null',
    );
    expect(pageSource).toContain('activeRowBusy={manualOperation?.[0] === sub.id}');
    expect(pageSource).toContain('data-operation-kind={activeRowBusy ? operationKind : undefined}');
    expect(pageSource).toContain('aria-busy={activeRowBusy || undefined}');
    expect(pageSource).toContain(
      'const rowControlsDisabled = pending || anyEditing || globalMutationBusy',
    );
    expect(pageSource).toContain('readOnly={operationBusy}');
    expect(pageSource).toContain('locked={globalMutationBusy}');
    expect(pageSource).toContain('pending={globalMutationBusy');
    expect(pageSource).toContain('blocked={isOperationActive}');
    expect(pageSource).toContain('guardPageAction');
    expect(pageSource).toContain(
      'const manualLeaseRef = useRef<ManualRefreshOperationLease | null>(operation)',
    );
    expect(pageSource).toMatch(
      /function startManualOperation[\s\S]*?manualLeaseRef\.current = lease/,
    );
    expect(pageSource).toMatch(
      /async function importContent\(\) \{\s*if \(manualLeaseRef\.current \|\| isOperationActive\(\)\) return;/,
    );
    expect(pageSource).toMatch(
      /onChange=\{\(value\) => \{[\s\S]*?if \(manualLeaseRef\.current \|\| isOperationActive\(\)\) return;/,
    );
  });

  it('wires every competing page control to the parent operation state and guard', () => {
    expect(pageSource).toMatch(
      /handleTablistKey[\s\S]*?manualOperationControllerRef\.current\?\.current\(\)/,
    );
    expect(pageSource).toContain("onClick={() => guardPageAction(() => setTab('subs'))}");
    expect(pageSource).toContain(
      'onChange={(event) => guardPageAction(() => setQuery(event.target.value))}',
    );
    expect(pageSource).toContain('onClick={() => guardPageAction(() => setAdding((v) => !v))}');
    expect(pageSource).toContain('readOnly={operationBusy}');
    expect(pageSource).toMatch(/className=\{styles\.fileInput\}[\s\S]*?disabled=\{operationBusy\}/);
    expect(pageSource).toMatch(
      /fileRef\.current\?\.click\(\)[\s\S]*?disabled=\{operationBusy\}[\s\S]*?aria-busy=\{filePending\}/,
    );
    expect(pageSource).toMatch(
      /type="submit"[\s\S]*?disabled=\{operationBusy \|\| !content\.trim\(\)\}[\s\S]*?aria-busy=\{pastePending\}/,
    );
    expect(pageSource).toContain(
      'if (!manualLeaseRef.current && !isOperationActive()) onCancel();',
    );
    expect(pageSource.match(/disabled=\{rowControlsDisabled\}/g)).toHaveLength(3);
    expect(pageSource).toContain('disabled={rowControlsDisabled || !sub.enabled}');
    expect(pageSource).toContain('disabled={rowControlsDisabled || manualUpdating}');
    expect(pageSource).toContain(
      'disabled={rowControlsDisabled || manualUpdating || !sub.enabled}',
    );
    expect(pageSource).toContain(
      '<DistChip enabled={sub.enabled} onClick={onDistribute} disabled={activeRowBusy} />',
    );
    expect(pageSource).toMatch(/function PipelineLink[\s\S]*?if \(disabled \|\| blocked\?\.\(\)\)/);
    expect(pageSource).toMatch(/function NamingLink[\s\S]*?if \(disabled \|\| blocked\?\.\(\)\)/);
    expect(pageSource).toContain('if (pageMutationIsActive() || !dist) return;');
  });

  it('wires AddForm to its parent barrier before every create-side effect and awaits settlement', () => {
    const invocationStart = pageSource.indexOf('<AddForm\n');
    const invocationEnd = pageSource.indexOf('/>', invocationStart);
    const invocationSource = pageSource.slice(invocationStart, invocationEnd + 2);
    expect(invocationSource).toContain('operationBusy={globalMutationBusy}');
    expect(invocationSource).toContain('onOperationStart={onAddFormOperationStart}');
    expect(invocationSource).toContain('onOperationFinish={onAddFormOperationFinish}');
    expect(invocationSource).toContain('onAdded={onAddFormCommitted}');
    expect(pageSource).toMatch(
      /const pageMutationIsActive = useCallback\([\s\S]*?manualOperationControllerRef\.current\?\.current\(\) !== null \|\|[\s\S]*?addFormMutationControllerRef\.current\?\.current\(\) !== null/,
    );

    const addFormStart = pageSource.indexOf('function AddForm(');
    const editFormStart = pageSource.indexOf('function EditForm(');
    const addFormSource = pageSource.slice(addFormStart, editFormStart);
    expect(addFormSource).toContain('onAdded: (lease: AddFormMutationLease) => Promise<void>;');
    expect(addFormSource).toContain('operationBusy: boolean;');
    expect(addFormSource).toContain('onOperationStart: () => AddFormMutationLease | null;');
    expect(addFormSource).toContain('onOperationFinish: (lease: AddFormMutationLease) => void;');
    expect(addFormSource).toMatch(
      /async function submit\(e: React\.FormEvent\) \{\s*e\.preventDefault\(\);\s*const lease = onOperationStart\(\);\s*if \(!lease\) return;\s*let committed = false;\s*try \{\s*const slug = name\.trim\(\);/,
    );
    expect(addFormSource).toMatch(
      /await api\('\/api\/v1\/subscriptions',[\s\S]*?committed = true;\s*await onAdded\(lease\);/,
    );
    expect(addFormSource).toContain('if (!committed) onOperationFinish(lease);');
    expect(addFormSource).toContain('if (aliveRef.current) setPending(false);');
    expect(addFormSource).toContain(
      '<button type="submit" className="btn primary" disabled={operationBusy || pending || !name}>',
    );
    expect(pageSource).toMatch(
      /async function onAddFormCommitted\(lease: AddFormMutationLease\): Promise<void> \{[\s\S]*?setAdding\(false\);[\s\S]*?await reload\(\);[\s\S]*?controller\.finish\(lease\);/,
    );
  });

  it('projects combined mutation ownership through every AddForm edit and cancel surface', () => {
    expect(addFormSource).toMatch(/setKind\('remote'\)[\s\S]{0,160}?disabled=\{operationBusy\}/);
    expect(addFormSource).toMatch(/setKind\('local'\)[\s\S]{0,160}?disabled=\{operationBusy\}/);
    for (const value of ['displayName', 'name', 'tagsInput', 'url', 'ua']) {
      expect(addFormSource).toMatch(
        new RegExp(`value=\\{${value}\\}[\\s\\S]{0,220}?readOnly=\\{operationBusy\\}`),
      );
    }
    expect(addFormSource).toMatch(
      /<TtlSeg[\s\S]{0,240}?disabled=\{operationBusy\}[\s\S]{0,80}?\/>/,
    );
    expect(addFormSource).toMatch(
      /setPolicy\('use-stale-cache'\)[\s\S]{0,160}?disabled=\{operationBusy\}/,
    );
    expect(addFormSource).toMatch(
      /setPolicy\('fail-closed'\)[\s\S]{0,160}?disabled=\{operationBusy\}/,
    );
    expect(addFormSource).toMatch(/<CodeEditor[\s\S]{0,320}?readOnly=\{operationBusy\}/);
    expect(addFormSource).toMatch(
      /setEnabled\(\(v\) => !v\)[\s\S]{0,160}?disabled=\{operationBusy\}/,
    );
    expect(addFormSource).toContain('disabled={operationBusy || pending}');
  });

  it('routes every AddForm edit and cancel callback through live fail-closed authority', () => {
    const invocationStart = pageSource.indexOf('<AddForm\n');
    const invocationEnd = pageSource.indexOf('/>', invocationStart);
    const invocationSource = pageSource.slice(invocationStart, invocationEnd + 2);
    expect(invocationSource).toContain('isOperationActive={pageMutationIsActive}');
    expect(addFormSource).toContain('isOperationActive: () => boolean;');
    expect(addFormSource).toMatch(
      /function guardAddFormAction\(action: \(\) => void\): void \{\s*if \(!aliveRef\.current \|\| isOperationActive\(\)\) return;\s*action\(\);\s*\}/,
    );
    expect(addFormSource.match(/guardAddFormAction\(\(\) => setKind\(/g)).toHaveLength(2);
    expect(addFormSource).toContain('guardAddFormAction(() => setDisplayName(e.target.value))');
    expect(addFormSource).toContain('guardAddFormAction(() => setName(e.target.value))');
    expect(addFormSource).toContain('guardAddFormAction(() => setTtlSec(sec))');
    expect(addFormSource.match(/guardAddFormAction\(\(\) => setPolicy\(/g)).toHaveLength(2);
    expect(addFormSource).toContain('guardAddFormAction(() => setTagsInput(e.target.value))');
    expect(addFormSource).toContain('guardAddFormAction(() => setUrl(e.target.value))');
    expect(addFormSource).toContain('guardAddFormAction(() => setUa(e.target.value))');
    expect(addFormSource).toContain('guardAddFormAction(() => setContent(value))');
    expect(addFormSource).toContain('guardAddFormAction(() => setEnabled((v) => !v))');
    expect(addFormSource).toMatch(/guardAddFormAction\(\(\) => [\s\S]*?confirmUnsavedChanges\(\)[\s\S]*?onCancel\(\)/);
    expect(addFormSource).not.toContain("onClick={() => setKind('");
    expect(addFormSource).not.toContain('onClick={() => setPolicy(');
    expect(addFormSource).not.toContain('onClick={() => setEnabled(');
  });

  it('keeps paste and file controls rendered while every manual control consumes busy state', () => {
    expect(pageSource).toContain('className={styles.fileInput}');
    expect(pageSource).toContain('value={content}');
    expect(pageSource).toContain('disabled={operationBusy || !content.trim()}');
    expect(pageSource).toContain('disabled={operationBusy}');
    expect(pageSource).toContain('aria-busy={filePending}');
    expect(pageSource).toContain('aria-busy={pastePending}');
    expect(pageSource).toContain('aria-busy={localFetchPending}');
  });

  it('renders blocking errors as alerts and source drift as a low-noise status', () => {
    expect(pageSource).toMatch(/role=["']alert["']/);
    expect(pageSource).toMatch(/role=["']status["']/);
    expect(pageSource).toContain('上游设置已变化');
  });

  it('uses page-scoped responsive styles with 40px mobile targets and no horizontal overflow', () => {
    expect(cssSource).toMatch(/min-height:\s*40px/);
    expect(cssSource).toMatch(/overflow-x:\s*hidden|overflow-wrap:\s*anywhere/);
    expect(cssSource).toContain('@media');
  });
});
