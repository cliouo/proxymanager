'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';

/**
 * 轻量 toast（对应原型 .toast-wrap / .toast）。position:fixed 覆盖层，
 * 无论页面滚到哪都可见 —— 这正是它比页内 error banner 更适合承接
 * 「操作被后端拒绝」这类反馈的原因（页内 banner 常悬在页顶，从下方的
 * 删除按钮触发时会滚出视口，用户只能打开控制台才看得到，见 cards.tsx /
 * chained-proxy / history 的错误上报）。
 *
 * 接入方式：
 *   1) 在 (authed) 子树包 <ToastProvider>；
 *   2) const toast = useToast();
 *      toast('已保存 · etag 已更新');                 // 中性成功/信息
 *      toast('撤销失败 · ' + err.message, { variant: 'error' }); // 危险态，停留更久便于阅读
 */
type ToastVariant = 'info' | 'error';
interface ToastOpts {
  variant?: ToastVariant;
  /** ms before auto-dismiss. Defaults: error 6000, info 2400. */
  duration?: number;
}
type ToastFn = (msg: string, opts?: ToastOpts) => void;

const ToastContext = createContext<ToastFn | null>(null);

interface ToastItem {
  id: number;
  msg: string;
  variant: ToastVariant;
}

const DEFAULT_DURATION: Record<ToastVariant, number> = { info: 2400, error: 6000 };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const toast = useCallback<ToastFn>((msg, opts) => {
    const variant = opts?.variant ?? 'info';
    const id = ++seq.current;
    setItems((prev) => [...prev, { id, msg, variant }]);
    const ttl = opts?.duration ?? DEFAULT_DURATION[variant];
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), ttl);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={t.variant === 'error' ? 'toast toast-err' : 'toast'}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return ctx;
}
