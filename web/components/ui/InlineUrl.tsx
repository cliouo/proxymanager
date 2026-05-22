'use client';

import { useState } from 'react';
import { Button } from './Button';

interface InlineUrlProps {
  value: string;
  /** 隐藏右侧"复制"按钮。 */
  bare?: boolean;
  /** 默认遮蔽 sub-providers / 类似敏感段，按"显示"切换；复制按钮始终复制完整 URL。 */
  mask?: boolean;
  className?: string;
}

/**
 * Dark micro-surface 标签：用于 Dashboard / 订阅卡上的可分享 URL。
 * 旁边紧贴一个白底 secondary button 形成「dark 标签 + 白纸按钮」对照。
 *
 * `mask` 模式下 token-bearing 段默认遮蔽为 `••••••`，旁边出"显示"按钮做一次性
 * 揭示。复制按钮在任何模式下都复制原始完整 URL —— 这是凭证级的最常用动作。
 */
export function InlineUrl({
  value,
  bare = false,
  mask = false,
  className = '',
}: InlineUrlProps) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard 不可用时静默 */
    }
  }

  const display = mask && !revealed ? maskTokenSegment(value) : value;

  return (
    <div className={`flex items-stretch gap-2 ${className}`}>
      <code
        className="surface-dark flex-1 min-w-0 bg-[var(--color-surface-dark)] text-[var(--color-on-dark)] font-mono text-[12px] leading-[1.55] rounded-lg px-3 py-2 overflow-x-auto whitespace-nowrap"
        title={mask && !revealed ? '点「显示」查看完整 URL，或直接「复制」' : value}
      >
        {display}
      </code>
      {mask && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? '隐藏 URL' : '显示完整 URL'}
          className="shrink-0"
        >
          {revealed ? '隐藏' : '显示'}
        </Button>
      )}
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

/**
 * 替换 sub-providers / sub / rule-providers 路径里的 token 段为 `••••••`。
 * Pattern: `…/<api-path>/<TOKEN>/<name>` → `…/<api-path>/••••••/<name>`
 * 不匹配时原样返回（fallback 安全）。
 */
function maskTokenSegment(url: string): string {
  return url.replace(
    /^(.*?\/(?:sub-providers|sub|rule-providers)\/)([^/]+)(\/.*)$/,
    (_full, prefix, _token, rest) => `${prefix}••••••${rest}`,
  );
}
