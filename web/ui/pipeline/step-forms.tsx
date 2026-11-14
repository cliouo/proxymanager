'use client';

import { useMemo, type ReactNode } from 'react';
import { REGIONS } from '@/lib/proxies/regions';
import { cn } from '@/ui/lib/cn';
import {
  Checkbox,
  Input,
  MultiCombobox,
  SegmentedControl,
  Select,
  TagInput,
  type ComboOption,
} from '@/ui/primitives';
import { Flag } from '@/ui/viz/nodes';
import {
  hasFlag,
  PROXY_TYPES,
  toggleFlag,
  uselessFragmentProblem,
  type EditableStep,
  type StepErrors,
} from './model';

type Patch = Partial<Record<string, unknown>>;

function Row({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3', className)}>
      <span className="w-[72px] shrink-0 text-xs text-ink-3">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">{children}</div>
    </div>
  );
}

function FieldError({ children, tone = 'bad' }: { children?: ReactNode; tone?: 'bad' | 'muted' }) {
  if (!children) return null;
  return <p className={cn('text-xs', tone === 'bad' ? 'text-bad' : 'text-ink-3')}>{children}</p>;
}

const MODE_OPTIONS = (subject: string) => [
  { value: 'keep' as const, label: `只保留${subject}` },
  { value: 'drop' as const, label: `删除${subject}` },
];

const TRI_OPTIONS = [
  { value: 'unset', label: '不修改' },
  { value: 'on', label: '开' },
  { value: 'off', label: '关' },
] as const;

type Tri = (typeof TRI_OPTIONS)[number]['value'];
const toTri = (value: boolean | undefined): Tri => (value === undefined ? 'unset' : value ? 'on' : 'off');
const fromTri = (value: Tri): boolean | undefined => (value === 'unset' ? undefined : value === 'on');

export function StepForm({
  op,
  onChange,
  errors,
  disabled,
}: {
  op: EditableStep;
  onChange: (patch: Patch) => void;
  errors?: StepErrors;
  disabled?: boolean;
}) {
  const regionOptions = useMemo<ComboOption[]>(
    () =>
      REGIONS.map((region) => ({
        value: region.code,
        label: region.zh,
        keywords: [region.code, region.alpha3],
        icon: <Flag region={region.code} size={14} />,
        description: region.code,
      })),
    [],
  );

  switch (op.kind) {
    case 'filter-regex': {
      const ignoreCase = hasFlag(op.flags, 'i', 'i');
      return (
        <div className="flex flex-col gap-2.5">
          <Row label="匹配后">
            <SegmentedControl
              size="sm"
              value={op.mode ?? 'keep'}
              onChange={(mode) => onChange({ mode })}
              options={MODE_OPTIONS('匹配的节点')}
            />
          </Row>
          <Row label="名称正则">
            <Input
              mono
              inputSize="sm"
              aria-label="名称正则"
              className="min-w-0 flex-1 basis-56"
              value={op.pattern}
              invalid={!!errors?.pattern && op.pattern !== ''}
              disabled={disabled}
              placeholder="例如 香港|日本|HK"
              onChange={(event) => onChange({ pattern: event.target.value })}
            />
            <Checkbox
              label={<span className="text-xs text-ink-2">忽略大小写</span>}
              checked={ignoreCase}
              disabled={disabled}
              onCheckedChange={(on) => onChange({ flags: toggleFlag(op.flags, 'i', 'i', on) })}
            />
          </Row>
          <FieldError tone={op.pattern === '' ? 'muted' : 'bad'}>{errors?.pattern}</FieldError>
        </div>
      );
    }

    case 'rename-regex': {
      const global = hasFlag(op.flags, 'g', 'g');
      const ignoreCase = hasFlag(op.flags, 'g', 'i');
      return (
        <div className="flex flex-col gap-2.5">
          <Row label="查找">
            <Input
              mono
              inputSize="sm"
              aria-label="查找（正则）"
              className="min-w-0 flex-1 basis-56"
              value={op.pattern}
              invalid={!!errors?.pattern && op.pattern !== ''}
              disabled={disabled}
              placeholder="例如 \s*\|\s*IPLC"
              onChange={(event) => onChange({ pattern: event.target.value })}
            />
          </Row>
          <FieldError tone={op.pattern === '' ? 'muted' : 'bad'}>{errors?.pattern}</FieldError>
          <Row label="替换为">
            <Input
              mono
              inputSize="sm"
              aria-label="替换为"
              className="min-w-0 flex-1 basis-56"
              value={op.replacement ?? ''}
              invalid={!!errors?.replacement}
              disabled={disabled}
              placeholder="留空即删除匹配到的文字"
              onChange={(event) => onChange({ replacement: event.target.value })}
            />
          </Row>
          <FieldError>{errors?.replacement}</FieldError>
          <Row label="选项">
            <Checkbox
              label={<span className="text-xs text-ink-2">替换全部匹配</span>}
              checked={global}
              disabled={disabled}
              onCheckedChange={(on) => onChange({ flags: toggleFlag(op.flags, 'g', 'g', on) })}
            />
            <Checkbox
              label={<span className="text-xs text-ink-2">忽略大小写</span>}
              checked={ignoreCase}
              disabled={disabled}
              onCheckedChange={(on) => onChange({ flags: toggleFlag(op.flags, 'g', 'i', on) })}
            />
          </Row>
        </div>
      );
    }

    case 'filter-useless':
      return (
        <div className="flex flex-col gap-2.5">
          <p className="text-xs leading-relaxed text-ink-3">
            默认会去掉名称里含「剩余流量、到期、官网、续费、客服、群组」等字样的节点。
          </p>
          <Row label="额外关键词">
            <TagInput
              mono
              className="min-w-0 flex-1"
              value={op.extra ?? []}
              disabled={disabled}
              validate={uselessFragmentProblem}
              placeholder="例如 测试|维护，回车添加"
              onChange={(extra) => onChange({ extra })}
            />
          </Row>
          <FieldError>{errors?.extra}</FieldError>
        </div>
      );

    case 'flag-emoji':
      return (
        <Row label="操作">
          <SegmentedControl
            size="sm"
            value={op.action ?? 'add'}
            onChange={(action) => onChange({ action })}
            options={[
              { value: 'add', label: '添加国旗' },
              { value: 'remove', label: '去掉国旗' },
            ]}
          />
          {(op.action ?? 'add') === 'add' && (
            <Checkbox
              label={<span className="text-xs text-ink-2">台湾节点使用 🇨🇳 国旗</span>}
              checked={!!op.tw2cn}
              disabled={disabled}
              onCheckedChange={(on) => onChange({ tw2cn: on || undefined })}
            />
          )}
        </Row>
      );

    case 'filter-type': {
      const selected = new Set<string>(op.types ?? []);
      return (
        <div className="flex flex-col gap-2.5">
          <Row label="匹配后">
            <SegmentedControl
              size="sm"
              value={op.mode ?? 'keep'}
              onChange={(mode) => onChange({ mode })}
              options={MODE_OPTIONS('这些协议')}
            />
          </Row>
          <Row label="协议">
            <div className="flex flex-wrap gap-1.5">
              {PROXY_TYPES.map((type) => {
                const on = selected.has(type);
                return (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={on}
                    disabled={disabled}
                    onClick={() =>
                      onChange({
                        types: on ? (op.types ?? []).filter((t) => t !== type) : [...(op.types ?? []), type],
                      })
                    }
                    className={cn(
                      'h-6 rounded-md border px-2 font-mono text-[11.5px] transition-colors',
                      'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-50',
                      on
                        ? 'border-accent-line bg-accent-soft text-accent'
                        : 'border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink',
                    )}
                  >
                    {type}
                  </button>
                );
              })}
            </div>
          </Row>
          {selected.size === 0 && <FieldError tone="muted">还没选协议，这一步暂时不会生效。</FieldError>}
        </div>
      );
    }

    case 'filter-region':
      return (
        <div className="flex flex-col gap-2.5">
          <Row label="匹配后">
            <SegmentedControl
              size="sm"
              value={op.mode ?? 'keep'}
              onChange={(mode) => onChange({ mode })}
              options={MODE_OPTIONS('这些地区')}
            />
          </Row>
          <Row label="地区">
            <MultiCombobox
              value={op.regions ?? []}
              onChange={(regions) => onChange({ regions })}
              options={regionOptions}
              disabled={disabled}
              placeholder="选择地区"
              searchPlaceholder="搜索地区或代码，如 HK"
              renderChip={(code, option) => (
                <span className="inline-flex items-center gap-1">
                  <Flag region={code} size={12} />
                  {option?.label ?? code}
                </span>
              )}
            />
          </Row>
          {(op.regions ?? []).length === 0 && (
            <FieldError tone="muted">还没选地区，这一步暂时不会生效。名称里认不出地区的节点不算匹配。</FieldError>
          )}
        </div>
      );

    case 'sort':
      return (
        <Row label="排序依据">
          <div className="w-32">
            <Select
              size="sm"
              value={op.by ?? 'name'}
              onValueChange={(by) => onChange({ by })}
              disabled={disabled}
              options={[
                { value: 'name', label: '名称' },
                { value: 'region', label: '地区' },
                { value: 'type', label: '协议' },
                { value: 'server', label: '服务器地址' },
              ]}
            />
          </div>
          <SegmentedControl
            size="sm"
            value={op.order ?? 'asc'}
            onChange={(order) => onChange({ order })}
            options={[
              { value: 'asc', label: '升序' },
              { value: 'desc', label: '降序' },
            ]}
          />
        </Row>
      );

    case 'set-prop':
      return (
        <div className="flex flex-col gap-2">
          {(
            [
              ['udp', 'UDP'],
              ['tfo', 'TFO'],
              ['skipCertVerify', '跳过证书验证'],
            ] as const
          ).map(([key, label]) => (
            <Row key={key} label={label}>
              <SegmentedControl
                size="sm"
                value={toTri(op[key])}
                onChange={(value) => onChange({ [key]: fromTri(value) })}
                options={TRI_OPTIONS.map((o) => ({ ...o }))}
              />
            </Row>
          ))}
        </div>
      );

    case 'dedup':
      return (
        <div className="flex flex-col gap-2.5">
          <Row label="算作重复">
            <SegmentedControl
              size="sm"
              value={op.by ?? 'name'}
              onChange={(by) => onChange({ by })}
              options={[
                { value: 'name', label: '名称相同' },
                { value: 'server-port', label: '服务器和端口相同' },
              ]}
            />
          </Row>
          <Row label="处理方式">
            <SegmentedControl
              size="sm"
              value={op.action ?? 'drop'}
              onChange={(action) => onChange({ action })}
              options={[
                { value: 'drop', label: '只留第一个' },
                { value: 'rename', label: '改名区分' },
              ]}
            />
          </Row>
        </div>
      );
  }
}
