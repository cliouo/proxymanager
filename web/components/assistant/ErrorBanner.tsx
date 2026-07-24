'use client';

/**
 * Turn-fatal error display for the assistant (model/stream failures), with an
 * optional retry. Raw model-service errors (e.g. `... HTTP 400: {json}` or the
 * browser agent's `模型请求失败（400）{json}`) are decoded into a friendly title +
 * collapsible detail instead of dumping JSON. The endpoint is user-configurable
 * (any OpenAI-compatible service), so wording stays brand-neutral. // P3-25
 */

import { useState } from 'react';

function parseError(message: string): { title: string; detail?: string } {
  // P3-25: match either the server `<provider> HTTP <code>: <body>` shape or the
  // browser agent's `模型请求失败（<code>）<body>` shape — the service is whatever
  // OpenAI-compatible endpoint the user set in「AI 配置」, so decode by code only.
  const http =
    /HTTP\s*(\d{3}):\s*([\s\S]*)/.exec(message) ||
    /模型请求失败（(\d{3})）\s*([\s\S]*)/.exec(message);
  if (http) {
    const code = http[1];
    let detail = http[2]?.trim();
    try {
      const j = JSON.parse(detail) as { error?: { message?: string } };
      if (j?.error?.message) detail = j.error.message;
    } catch {
      /* keep raw detail */
    }
    const title =
      code === '401'
        ? '模型服务鉴权失败（检查 API Key）'
        : code === '402'
          ? '模型服务账户余额不足'
          : code === '429'
            ? '模型服务触发限流，请稍后重试'
            : code === '400'
              ? '模型服务拒绝了请求'
              : code.startsWith('5')
                ? '模型服务暂时异常'
                : `模型服务返回错误 ${code}`;
    return { title, detail };
  }
  if (/DEEPSEEK_API_KEY|尚未配置|not configured/i.test(message)) {
    return {
      title: '助手尚未配置',
      detail: '请到「助手设置」页填写模型服务的 Base URL、模型和 API Key。',
    };
  }
  if (/abort/i.test(message)) return { title: '请求已取消' };
  return { title: '出错了', detail: message };
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { title, detail } = parseError(message);
  const [open, setOpen] = useState(false);
  const long = !!detail && detail.length > 120;

  return (
    <div className="rounded-lg border border-[var(--color-border)] border-l-2 border-l-[var(--color-danger)] bg-[var(--color-surface)] p-3">
      <div className="flex items-start gap-2">
        <span className="leading-5 text-[var(--color-danger)]">⚠</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[var(--color-fg)]">{title}</div>
          {detail && (
            <div className="mt-0.5 break-words text-[12px] leading-relaxed text-[var(--color-muted)]">
              {open || !long ? detail : `${detail.slice(0, 120)}…`}
            </div>
          )}
          <div className="mt-2 flex items-center gap-3">
            {onRetry && (
              <button
                onClick={onRetry}
                className="text-[12px] font-medium text-[var(--color-primary)] hover:text-[var(--color-primary-hover)]"
              >
                ↻ 重试
              </button>
            )}
            {long && (
              <button
                onClick={() => setOpen((o) => !o)}
                className="text-[12px] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
              >
                {open ? '收起' : '详情'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
