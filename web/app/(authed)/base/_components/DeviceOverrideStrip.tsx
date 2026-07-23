'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client/api';
import { useProfiles } from '@/components/profile/ProfileContext';
import { overridesByTopLevelKey, topLevelKeyLines } from '@/lib/profiles/devicePresets';
import styles from '../base.module.css';

/**
 * 共享层的**反向标注** —— 在 base 编辑器里指出「你改的这个键，有 N 台设备覆盖了」。
 *
 * 这是 overlay 类系统的头号投诉（「我明明改了，怎么这台机器没生效」）的解药：
 * 差异是设备那边单向叠加的，共享层如果什么都不说，用户永远不知道自己改的值
 * 在某台设备上根本不会生效。
 *
 * 纯客户端计算：读一次该配置文件的设备列表，与编辑器里的顶层键取交集。无新后端。
 * 敏感键只显示「已设置」，绝不把值搬到这里来。
 */

const SENSITIVE_KEYS = new Set([
  'secret',
  'auth-key',
  'authentication',
  'password',
  'private-key',
  'token',
]);

interface DeviceLite {
  id: string;
  name: string;
  base_patch: Record<string, unknown>;
}

function valueLabel(key: string, value: unknown): string {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) return '***（已设置）';
  if (value === null) return '删除该键';
  if (Array.isArray(value)) return `[${value.length} 项]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).join(', ')}}`;
  return String(value);
}

export function DeviceOverrideStrip({ content }: { content: string }) {
  const { activeProfile } = useProfiles();
  const [devices, setDevices] = useState<DeviceLite[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProfile) return;
    let cancelled = false;
    api<{ data: DeviceLite[] }>(`/api/v1/profiles/${activeProfile.id}/devices`)
      .then((r) => {
        if (!cancelled) setDevices(r.data);
      })
      // 徽章是辅助信息，拉不到就安静降级 —— 绝不因此挡住 base 编辑。
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeProfile]);

  const overrides = useMemo(() => overridesByTopLevelKey(devices), [devices]);
  const lines = useMemo(() => topLevelKeyLines(content), [content]);

  // 只标注**这份 base 里出现过**的键；设备补丁新增的键在共享层无处可标，
  // 它们本来就不是「我改了却没生效」那类困惑的来源。
  const rows = useMemo(
    () =>
      [...overrides.entries()]
        .filter(([key]) => lines.has(key))
        .sort((a, b) => (lines.get(a[0]) ?? 0) - (lines.get(b[0]) ?? 0)),
    [overrides, lines],
  );

  if (rows.length === 0) return null;

  return (
    <div className={styles.hint} style={{ display: 'grid', gap: 8 }}>
      <div>
        <b>设备覆盖</b> —— 下面这些顶层键被本配置文件的设备补丁覆盖了；改它们不会影响
        对应设备的下发内容。
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {rows.map(([key, names]) => (
          <button
            key={key}
            type="button"
            className={`pill ${open === key ? 'acc' : 'idle'} plain`}
            style={{ cursor: 'pointer', border: 'none' }}
            onClick={() => setOpen(open === key ? null : key)}
            title={`第 ${lines.get(key)} 行 · ${names.join('、')}`}
          >
            <span className="mono">{key}</span> · {names.length} 台设备覆盖
          </button>
        ))}
      </div>
      {open && (
        <div style={{ display: 'grid', gap: 4 }}>
          {devices
            .filter((d) => open in (d.base_patch ?? {}))
            .map((d) => (
              <div key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <Link
                  className="mono"
                  href={`/profiles/${activeProfile?.id}/devices/${d.id}`}
                  style={{ color: 'var(--accent)', textDecoration: 'none' }}
                >
                  {d.name}
                </Link>
                <span style={{ color: 'var(--faint)' }}>→</span>
                <span className="mono">{valueLabel(open, d.base_patch[open])}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
