'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';

/**
 * 轻量 toast（对应原型 .toast-wrap / .toast）。
 * 本轮仅搭好供后续页面保存反馈复用；接入方式：
 *   1) 在 (authed) 子树包 <ToastProvider>；
 *   2) const toast = useToast(); toast('已保存 · etag 已更新');
 */
type ToastFn = (msg: string) => void;

const ToastContext = createContext<ToastFn | null>(null);

interface ToastItem {
  id: number;
  msg: string;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const toast = useCallback<ToastFn>((msg) => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { id, msg }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 2400);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className="toast">
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
