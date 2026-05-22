'use client';

import { useState } from 'react';
import { Button } from './Button';

interface InlineUrlProps {
  value: string;
  /** 隐藏右侧"复制"按钮。 */
  bare?: boolean;
  className?: string;
}

/**
 * Dark micro-surface 标签：用于 Dashboard / 订阅卡上的可分享 URL。
 * 旁边紧贴一个白底 secondary button 形成「dark 标签 + 白纸按钮」对照。
 */
export function InlineUrl({ value, bare = false, className = '' }: InlineUrlProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard 不可用时静默 */
    }
  }

  return (
    <div className={`flex items-stretch gap-2 ${className}`}>
      <code
        className="surface-dark flex-1 min-w-0 bg-[var(--color-surface-dark)] text-[var(--color-on-dark)] font-mono text-[12px] leading-[1.55] rounded-lg px-3 py-2 overflow-x-auto whitespace-nowrap"
        title={value}
      >
        {value}
      </code>
      {!bare && (
        <Button
          variant="secondary"
          size="sm"
          onClick={copy}
          aria-label={copied ? '已复制' : '复制 URL'}
          className="shrink-0"
        >
          {copied ? '已复制' : '复制'}
        </Button>
      )}
    </div>
  );
}
