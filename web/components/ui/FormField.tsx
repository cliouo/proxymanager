import type { ReactNode } from 'react';

export function FormField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}
