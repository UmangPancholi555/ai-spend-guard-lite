import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/projects', label: 'Projects' },
  { to: '/usage', label: 'Usage' },
  { to: '/simulator', label: 'Request Simulator' },
  { to: '/budgets', label: 'Budgets & Alerts' },
  { to: '/activity', label: 'Activity' },
  { to: '/traces', label: 'Traces' },
  { to: '/observability', label: 'Observability' },
  { to: '/errors', label: 'Error Log' },
  { to: '/logs', label: 'Execution Logs' },
  { to: '/settings', label: 'Settings' },
];

export default function Layout() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [open, setOpen] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
  }, [dark]);

  return (
    <div className="flex min-h-screen">
      <aside className={`fixed inset-y-0 left-0 z-30 w-60 transform border-r border-slate-200 bg-white transition-transform dark:border-slate-800 dark:bg-slate-900 md:static md:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`} data-testid="sidebar">
        <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-4 dark:border-slate-800">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-sm font-bold text-white">S</div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Spend Guard Lite</div>
            <div className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">Demo / Simulated</div>
          </div>
        </div>
        <nav className="space-y-0.5 p-2">
          {NAV.map(n => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm font-medium ${isActive ? 'bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-100' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      {open && <div className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={() => setOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-slate-200 bg-white/80 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
          <button className="rounded p-2 md:hidden" aria-label="Open menu" onClick={() => setOpen(o => !o)}>☰</button>
          <div className="hidden text-xs text-amber-700 dark:text-amber-300 md:block" data-testid="sim-banner">
            All provider traffic is local, simulated mock data - no external AI requests are ever made.
          </div>
          <button
            className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            onClick={() => setDark(d => !d)}
            aria-label="Toggle theme"
            data-testid="theme-toggle"
          >
            {dark ? 'Light' : 'Dark'} mode
          </button>
        </header>
        <main className="min-w-0 flex-1 p-4 md:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
