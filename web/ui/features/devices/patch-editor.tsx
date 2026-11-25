'use client';

import { useMemo, useState } from 'react';
import { Dices, Eye, EyeOff, MoreHorizontal, Plus, Undo2 } from 'lucide-react';
import { Button as UiButton } from '@ui-sdk/react/button';
import { CodeEditor } from '@/ui/editor/code-editor';
import { cn } from '@/ui/lib/cn';
import {
  Badge,
  Button,
  Combobox,
  Input,
  Menu,
  notify,
  Select,
  Switch,
  Tooltip,
  type ComboOption,
  type MenuEntry,
} from '@/ui/primitives';
import {
  convertValue,
  defaultValueFor,
  inlineValue,
  isPlainObject,
  isSensitiveKey,
  KIND_LABEL,
  keyMeta,
  MANAGED_PATCH_KEYS,
  parseYamlValue,
  PATCH_KEYS,
  randomSecret,
  toYaml,
  valueKind,
  type Patch,
  type PatchProblem,
  type ValueKind,
} from './model';

/* ─── add-a-difference picker ────────────────────────────────────────── */

export function AddDifference({
  draft,
  shared,
  onAdd,
  size = 'sm',
  variant = 'secondary',
}: {
  draft: Patch;
  shared: Patch | null;
  onAdd: (key: string, value: unknown) => void;
  size?: 'sm' | 'md';
  variant?: 'secondary' | 'primary';
}) {
  const options = useMemo<ComboOption[]>(
    () =>
      PATCH_KEYS.filter((meta) => !(meta.key in draft)).map((meta) => ({
        value: meta.key,
        label: meta.label,
        description: (
          <>
            <span className="font-mono">{meta.key}</span> · {meta.hint}
          </>
        ),
        keywords: [meta.key, meta.hint],
        group: meta.common ? '常用' : '更多',
      })),
    [draft],
  );

  const add = (raw: string) => {
    const key = raw.trim();
    if (!key) return;
    if (MANAGED_PATCH_KEYS.includes(key)) {
      notify.warn(`${key} 不能按设备修改`, '节点、策略组、规则、规则集由共享层统一管理；需要不同的话请另建一份配置文件。');
      return;
    }
    if (key in draft) return;
    onAdd(key, defaultValueFor(key, shared?.[key]));
  };

  return (
    <Combobox
      value={null}
      onChange={add}
      options={options}
      allowCustom
      customLabel={(query) => (
        <>
          添加自定义键 <span className="font-mono">{query}</span>
        </>
      )}
      searchPlaceholder="搜索：端口、tun、日志…"
      emptyText="没有匹配的常用项，可直接输入键名"
      width={360}
      trigger={
        <Button variant={variant} size={size} icon={Plus}>
          添加差异
        </Button>
      }
    />
  );
}

/* ─── structured list ────────────────────────────────────────────────── */

export function PatchForm({
  draft,
  onChange,
  shared,
  revision,
  focusKey,
  rowErrors,
  onRowError,
  problems,
}: {
  draft: Patch;
  onChange: (next: Patch) => void;
  shared: Patch | null;
  revision: number;
  focusKey: string | null;
  rowErrors: Record<string, string>;
  onRowError: (key: string, error: string | null) => void;
  problems: PatchProblem[];
}) {
  const entries = Object.entries(draft);
  const problemFor = (key: string) => problems.find((p) => p.key === key)?.message ?? null;

  const setValue = (key: string, value: unknown) => onChange({ ...draft, [key]: value });
  const remove = (key: string) => {
    const next = { ...draft };
    delete next[key];
    onChange(next);
    onRowError(key, null);
  };
  const setKind = (key: string, kind: ValueKind) => {
    onRowError(key, null);
    onChange({ ...draft, [key]: convertValue(draft[key], kind, key) });
  };

  if (entries.length === 0) return null;

  return (
    <ul className="flex flex-col divide-y divide-line">
      {entries.map(([key, value]) => (
        <PatchRow
          key={`${revision}:${key}`}
          k={key}
          value={value}
          shared={shared}
          autoFocus={focusKey === key}
          error={rowErrors[key] ?? problemFor(key)}
          onValue={(next) => setValue(key, next)}
          onKind={(kind) => setKind(key, kind)}
          onRemove={() => remove(key)}
          onError={(error) => onRowError(key, error)}
        />
      ))}
    </ul>
  );
}

const KINDS: ValueKind[] = ['string', 'number', 'boolean', 'object', 'null'];

function PatchRow({
  k,
  value,
  shared,
  autoFocus,
  error,
  onValue,
  onKind,
  onRemove,
  onError,
}: {
  k: string;
  value: unknown;
  shared: Patch | null;
  autoFocus: boolean;
  error: string | null;
  onValue: (value: unknown) => void;
  onKind: (kind: ValueKind) => void;
  onRemove: () => void;
  onError: (error: string | null) => void;
}) {
  const meta = keyMeta(k);
  const kind = valueKind(value);
  const sharedValue = shared ? shared[k] : undefined;
  const hasEnable = isPlainObject(value) && typeof value.enable === 'boolean';

  const menu: MenuEntry[] = [
    { heading: '值类型' },
    ...KINDS.map((option) => ({
      label: KIND_LABEL[option],
      checked: option === kind,
      onSelect: () => onKind(option),
    })),
    'separator',
    { label: '移除这项差异', icon: Undo2, tone: 'danger', hint: '恢复为共享配置', onSelect: onRemove },
  ];

  let control: React.ReactNode;
  if (kind === 'boolean') {
    control = (
      <label className="flex h-8 items-center gap-2 text-sm text-ink-2">
        <Switch checked={value as boolean} onCheckedChange={onValue} label={meta?.label ?? k} />
        {value ? '开' : '关'}
      </label>
    );
  } else if (kind === 'number') {
    control = <NumberField value={value as number} onValue={onValue} onError={onError} autoFocus={autoFocus} label={k} />;
  } else if (kind === 'string') {
    const text = value as string;
    if (meta?.options) {
      const options = meta.options.includes(text) || !text ? meta.options : [text, ...meta.options];
      control = (
        <Select
          mono
          label={meta?.label ?? k}
          value={text || undefined}
          onValueChange={onValue}
          options={options.map((o) => ({ value: o, label: o }))}
        />
      );
    } else if (isSensitiveKey(k)) {
      control = <SecretField value={text} onValue={onValue} autoFocus={autoFocus} canGenerate={k === 'secret'} label={k} />;
    } else {
      control = (
        <Input
          mono
          value={text}
          autoFocus={autoFocus}
          aria-label={k}
          placeholder="值"
          onChange={(event) => onValue(event.target.value)}
        />
      );
    }
  } else if (kind === 'object') {
    control = hasEnable ? (
      <label className="flex h-8 items-center gap-2 text-sm text-ink-2">
        <Switch
          checked={(value as Patch).enable as boolean}
          onCheckedChange={(checked) => onValue({ ...(value as Patch), enable: checked })}
          label={`${meta?.label ?? k} 开关`}
        />
        {(value as Patch).enable ? '开' : '关'}
      </label>
    ) : (
      <Badge tone="neutral">{Array.isArray(value) ? '列表' : '对象'} · 下方编辑</Badge>
    );
  } else {
    control = (
      <Badge tone="bad" className="h-6">
        从共享配置中删除这一项
      </Badge>
    );
  }

  return (
    <li className="flex flex-col gap-2.5 py-3.5 first:pt-1">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-5">
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium text-ink">{meta?.label ?? <span className="font-mono">{k}</span>}</span>
            {meta && <span className="font-mono text-[11px] text-ink-4">{k}</span>}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{meta?.hint ?? '自定义键：按 mihomo 配置的顶层键原样写入'}</p>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-1 sm:w-[264px]">
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">{control}</div>
            <Menu
              items={menu}
              trigger={<Button variant="ghost" size="md" iconOnly icon={MoreHorizontal} aria-label={`${meta?.label ?? k} 的更多操作`} />}
            />
          </div>
          <span className="truncate pr-9 text-2xs text-ink-3" title={sharedValue === undefined ? undefined : inlineValue(k, sharedValue)}>
            {sharedValue === undefined ? (
              shared ? '共享配置里没有这一项' : ' '
            ) : (
              <>
                共享配置：<span className="font-mono text-ink-2">{inlineValue(k, sharedValue)}</span>
              </>
            )}
          </span>
        </div>
      </div>
      {kind === 'object' && <YamlValue label={`${meta?.label ?? k} YAML`} value={value} onValue={onValue} onError={onError} invalid={!!error} />}
      {error && <p className="text-xs text-bad">{error}</p>}
    </li>
  );
}

/* ─── typed fields ───────────────────────────────────────────────────── */

function NumberField({
  value,
  onValue,
  onError,
  autoFocus,
  label,
}: {
  value: number;
  onValue: (value: number) => void;
  onError: (error: string | null) => void;
  autoFocus: boolean;
  label: string;
}) {
  const [text, setText] = useState(String(value));
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setText(String(value));
  }
  return (
    <Input
      mono
      inputMode="numeric"
      value={text}
      autoFocus={autoFocus}
      aria-label={label}
      invalid={!/^-?\d+(\.\d+)?$/.test(text.trim())}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const trimmed = next.trim();
        if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
          const n = Number(trimmed);
          setSynced(n);
          onError(null);
          onValue(n);
        } else {
          onError('请输入数字');
        }
      }}
    />
  );
}

function SecretField({
  value,
  onValue,
  autoFocus,
  canGenerate,
  label,
}: {
  value: string;
  onValue: (value: string) => void;
  autoFocus: boolean;
  canGenerate: boolean;
  label: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex items-center gap-1" data-agent-secret>
      <Input
        mono
        className="min-w-0 flex-1"
        type={shown ? 'text' : 'password'}
        value={value}
        autoFocus={autoFocus}
        autoComplete="off"
        data-agent-secret
        aria-label={label}
        onChange={(event) => onValue(event.target.value)}
        trailing={
          <UiButton
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? `隐藏 ${label}` : `显示 ${label}`}
            className="flex size-6 items-center justify-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            {shown ? <EyeOff size={13} /> : <Eye size={13} />}
          </UiButton>
        }
      />
      {canGenerate && (
        <Tooltip content="随机生成新密钥">
          <Button variant="ghost" iconOnly icon={Dices} aria-label="随机生成新密钥" onClick={() => onValue(randomSecret())} />
        </Tooltip>
      )}
    </div>
  );
}

/** A nested value edited as a small YAML document; parses on every keystroke. */
function YamlValue({
  label,
  value,
  onValue,
  onError,
  invalid,
}: {
  label: string;
  value: unknown;
  onValue: (value: unknown) => void;
  onError: (error: string | null) => void;
  invalid: boolean;
}) {
  const json = JSON.stringify(value);
  const [text, setText] = useState(() => toYaml(value));
  const [synced, setSynced] = useState(json);
  if (json !== synced) {
    setSynced(json);
    setText(toYaml(value));
  }
  const lines = Math.min(Math.max(text.split('\n').length, 3), 14);
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-surface-2/50 transition-colors focus-within:border-accent',
        invalid ? 'border-bad' : 'border-line',
      )}
    >
      <CodeEditor
        label={label}
        value={text}
        lineNumbers={false}
        height={`${lines * 18 + 22}px`}
        placeholder="enable: true"
        onChange={(next) => {
          setText(next);
          const parsed = parseYamlValue(next);
          if (parsed.error) {
            onError(parsed.error);
            return;
          }
          const v = parsed.value ?? {};
          if (typeof v !== 'object') {
            onError('这里需要「键: 值」映射或列表');
            return;
          }
          onError(null);
          setSynced(JSON.stringify(v));
          onValue(v);
        }}
      />
    </div>
  );
}
