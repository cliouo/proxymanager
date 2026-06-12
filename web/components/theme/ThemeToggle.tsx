'use client';

import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';

type Mode = 'light' | 'dark' | 'system';

const MODES: { v: Mode; ico: string; lbl: string }[] = [
  { v: 'light', ico: '☀', lbl: '浅色' },
  { v: 'dark', ico: '☾', lbl: '深色' },
  { v: 'system', ico: '◐', lbl: '跟随系统' },
];

/**
 * 三态主题切换器（浅色 / 深色 / 跟随系统），对应原型 .theme-ctl 弹层。
 * 由 next-themes 的 useTheme 驱动；mounted 守卫避免服务端/客户端不一致。
 */
export function ThemeToggle() {
  const { theme, setTheme, systemTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 服务端渲染时主题未知 —— 渲染中性占位，避免 hydration mismatch。
  if (!mounted) {
    return (
      <div className="theme-ctl">
        <button type="button" className="theme-toggle" aria-label="主题切换">
          <span className="ico">◐</span>
        </button>
      </div>
    );
  }

  const current = (theme as Mode) || 'system';
  const active = MODES.find((m) => m.v === current) ?? MODES[0];
  const resolvedLabel =
    current === 'system' ? `（当前${systemTheme === 'dark' ? '深色' : '浅色'}）` : '';

  return (
    <div className="theme-ctl" ref={ref}>
      <button
        type="button"
        className="theme-toggle"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="主题 · 浅色 / 深色 / 跟随系统"
        title={`主题：${active.lbl}${resolvedLabel} · 点击切换`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className="ico">{active.ico}</span>
      </button>
      <div className={`theme-pop${open ? ' open' : ''}`} role="menu">
        {MODES.map((m) => (
          <button
            key={m.v}
            type="button"
            className="theme-opt"
            role="menuitemradio"
            aria-checked={current === m.v}
            onClick={() => {
              setTheme(m.v);
              setOpen(false);
            }}
          >
            <span className="g">{m.ico}</span>
            <span className="lbl">{m.lbl}</span>
            <span className="ck">✓</span>
          </button>
        ))}
      </div>
    </div>
  );
}
