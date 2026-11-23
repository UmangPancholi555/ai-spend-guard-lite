import { Link, useLocation } from 'react-router-dom';
import { NAV_SECTIONS } from '../lib/nav';

export default function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <div className="mx-auto max-w-2xl py-8" data-testid="not-found">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Nothing lives at <code className="break-all rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-slate-800">{pathname}</code>. The link may be mistyped or the item may have been removed.
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {NAV_SECTIONS.map(s => (
          <section key={s.id} aria-label={s.label}>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">{s.label}</h2>
            <ul className="space-y-1">
              {s.items.map(i => (
                <li key={i.to}><Link to={i.to} className="text-sm text-brand-700 underline hover:text-brand-600 dark:text-brand-100">{i.label}</Link></li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
