'use client';

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { ArrowUp, Play, Square } from 'lucide-react';
import { useIsomorphicLayoutEffect } from '@/ui/data/query';
import { cn } from '@/ui/lib/cn';
import { Tooltip } from '@/ui/primitives';

export interface ComposerHandle {
  focus: () => void;
  setValue: (value: string) => void;
}

const MAX_HEIGHT = 180;

export const Composer = forwardRef<
  ComposerHandle,
  {
    running: boolean;
    paused?: boolean;
    onResume?: () => void;
    onSend: (text: string) => void;
    onStop: () => void;
  }
>(function Composer({ running, paused = false, onResume, onSend, onStop }, ref) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [value, setValue] = useState('');

  useImperativeHandle(ref, () => ({
    focus: () => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    },
    setValue,
  }));

  // Auto-grow up to MAX_HEIGHT, then scroll inside.
  useIsomorphicLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, MAX_HEIGHT)}px`;
    area.style.overflowY = area.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [value]);

  const canSend = !running && value.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    onSend(value);
    setValue('');
  };

  return (
    <div className="px-3 pb-3 pt-1">
      <div className="rounded-xl border border-line bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-line-strong focus-within:shadow-md">
        <textarea
          ref={areaRef}
          rows={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return;
            // Enter that commits an IME candidate must not send.
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            send();
          }}
          placeholder={running ? '助手正在回答…' : '问点什么，或让我改点什么…'}
          aria-label="给 AI 助手发消息"
          className="block min-h-[44px] w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-4"
        />
        <div className="flex items-center gap-2 pb-2 pl-3 pr-2">
          <span className={cn('min-w-0 flex-1 truncate text-2xs', paused ? 'font-medium text-warn' : 'text-ink-4')}>
            {paused
              ? '页面操作已暂停 · 可继续或停止'
              : running
                ? '可以随时停止'
                : 'Enter 发送 · Shift+Enter 换行 · 改动需你确认'}
          </span>
          {running ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {paused && onResume && (
                <button
                  type="button"
                  onClick={onResume}
                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-warn/40 bg-warn-soft px-2 text-2xs font-medium text-warn transition hover:bg-warn/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <Play size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                  继续
                </button>
              )}
              <Tooltip content="停止">
                <button
                  type="button"
                  onClick={onStop}
                  aria-label="停止回答"
                  className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-inverse text-inverse-ink shadow-xs transition-colors hover:bg-inverse/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <Square size={10} fill="currentColor" strokeWidth={0} />
                </button>
              </Tooltip>
            </div>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              aria-label="发送"
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-lg bg-inverse text-inverse-ink shadow-xs transition-[background-color,transform] hover:bg-inverse/85 active:translate-y-px',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:bg-inverse/25',
              )}
            >
              <ArrowUp size={15} strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
