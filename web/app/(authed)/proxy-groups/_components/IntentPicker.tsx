'use client';

import type { ProxyGroupKind } from '@/schemas';
import { KIND_DESCRIPTIONS, KIND_LABELS, KIND_ORDER } from '../_lib/model';
import styles from '../proxyGroups.module.css';

const KIND_ICON: Record<ProxyGroupKind, string> = {
  manual: '✎',
  filter: '⌕',
  all: '⊞',
  'single-sub': '⛓',
  raw: '{}',
};

/** Step 1 of create — pick the intent. Presets pre-fill the same editor. */
export function IntentPicker({
  onPick,
  onCancel,
}: {
  onPick: (kind: ProxyGroupKind) => void;
  onCancel: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>想建哪种策略组?</h2>
        <span className="sub">预设只是把同一个编辑器调到合适形态</span>
        <div className="grow" />
        <button className="btn ghost sm" onClick={onCancel}>
          取消
        </button>
      </div>
      <div className="panel-body">
        <div className={styles.lensNote}>
          <span className="ic">ⓘ</span>
          选「手选 / 自由」从零拼装;任何字段随后都能在「高级」里改 — kind 是编辑视角,不锁定字段。
        </div>
        <div className={styles.intentGrid}>
          {KIND_ORDER.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => onPick(kind)}
              className={styles.intentCard}
            >
              <span className={`${styles.g} num`} aria-hidden>
                {KIND_ICON[kind]}
              </span>
              <span style={{ minWidth: 0 }}>
                <b>{KIND_LABELS[kind]}</b>
                <p>{KIND_DESCRIPTIONS[kind]}</p>
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
