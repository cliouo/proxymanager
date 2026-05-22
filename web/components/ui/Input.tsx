import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

const BASE =
  'w-full rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] px-3 text-[13px] text-[var(--color-fg)] placeholder-[var(--color-muted-strong)] transition-[border-color,box-shadow,background-color] duration-150 ease-out focus:outline-none focus:border-[var(--color-primary)] focus:ring-[3px] focus:ring-[var(--color-primary)]/20 disabled:opacity-40 disabled:cursor-not-allowed';

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${BASE} h-9 ${className}`} {...props} />;
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`${BASE} py-2 font-[var(--font-mono)] leading-[1.55] ${className}`}
      {...props}
    />
  );
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${BASE} h-9 cursor-pointer pr-8 appearance-none bg-[image:linear-gradient(45deg,transparent_50%,var(--color-muted)_50%),linear-gradient(135deg,var(--color-muted)_50%,transparent_50%)] bg-[position:calc(100%_-_14px)_50%,calc(100%_-_10px)_50%] bg-[size:4px_4px,4px_4px] bg-no-repeat ${className}`} {...props}>
      {children}
    </select>
  );
}
