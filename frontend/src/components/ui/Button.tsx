import type { ButtonHTMLAttributes } from 'react';
type V = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<V, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50',
  secondary: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50',
  ghost: 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
};
export function Button({ variant = 'primary', className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: V }) {
  return <button {...rest} className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${VARIANTS[variant]} ${className}`} />;
}
/** Anchor styled as a secondary button, for CSV/JSONL downloads. */
export function DownloadLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} download className={`rounded-md px-3 py-1.5 text-sm font-medium ${VARIANTS.secondary}`}>{children}</a>;
}
export const inputCls = 'rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900';
