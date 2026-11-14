'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/ui/lib/cn';
import { Tooltip } from './overlay';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for insecure contexts (http on LAN).
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  }
}

export function useCopy(timeout = 1600) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  const copy = useCallback(
    async (text: string, message?: string) => {
      const ok = await copyText(text);
      if (!ok) {
        toast.error('复制失败，请手动选择文本复制');
        return false;
      }
      setCopied(true);
      if (message) toast.success(message);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), timeout);
      return true;
    },
    [timeout],
  );
  return { copied, copy };
}

export function CopyIcon({ copied, size = 14 }: { copied: boolean; size?: number }) {
  return (
    <span className="relative inline-flex" style={{ width: size, height: size }}>
      <AnimatePresence initial={false} mode="popLayout">
        {copied ? (
          <motion.span
            key="check"
            initial={{ scale: 0.4, opacity: 0, rotate: -30 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={{ type: 'spring', bounce: 0.5, duration: 0.35 }}
            className="absolute inset-0 text-ok"
          >
            <Check size={size} strokeWidth={2.25} />
          </motion.span>
        ) : (
          <motion.span
            key="copy"
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0"
          >
            <Copy size={size} strokeWidth={1.75} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

export function CopyButton({
  text,
  label = '复制',
  message,
  className,
  size = 'md',
  showLabel,
}: {
  text: string;
  label?: string;
  message?: string;
  className?: string;
  size?: 'sm' | 'md';
  showLabel?: boolean;
}) {
  const { copied, copy } = useCopy();
  const button = (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        void copy(text, message);
      }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink',
        size === 'sm' ? 'h-6 min-w-6 px-1' : 'h-7 min-w-7 px-1.5',
        showLabel && 'border border-line bg-surface px-2.5 text-xs font-medium text-ink-2 shadow-xs',
        className,
      )}
    >
      <CopyIcon copied={copied} size={size === 'sm' ? 13 : 14} />
      {showLabel && <span>{copied ? '已复制' : label}</span>}
    </button>
  );
  return showLabel ? button : <Tooltip content={copied ? '已复制' : label}>{button}</Tooltip>;
}
