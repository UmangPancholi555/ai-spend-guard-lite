import type { ReactNode } from 'react';
import type { Pagination } from '@shared/types';
export function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
      <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
        <thead className="bg-slate-50 dark:bg-slate-900">
          <tr>{head.map(h => <th key={h} className="whitespace-nowrap px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white dark:divide-slate-800 dark:bg-slate-900/50">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}
export const Td = ({ children, className = '' }: { children?: ReactNode; className?: string }) => <td className={`whitespace-nowrap px-3 py-2 ${className}`}>{children}</td>;
export function EmptyState({ message }: { message: string }) {
  return <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400" data-testid="empty-state">{message}</div>;
}
export function PaginationBar({ p, onPage }: { p: Pagination; onPage: (n: number) => void }) {
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-slate-600 dark:text-slate-300">
      <span>{p.total} total - page {p.page} of {p.totalPages}</span>
      <div className="flex gap-2">
        <button className="rounded border px-2 py-1 disabled:opacity-40 dark:border-slate-700" disabled={p.page <= 1} onClick={() => onPage(p.page - 1)}>Prev</button>
        <button className="rounded border px-2 py-1 disabled:opacity-40 dark:border-slate-700" disabled={p.page >= p.totalPages} onClick={() => onPage(p.page + 1)}>Next</button>
      </div>
    </div>
  );
}
