import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import { Badge } from './ui/Badge';
import ErrorBoundary from './ui/ErrorBoundary';
import { Loading } from './ui/State';
import { NAV_SECTIONS, titleForPath } from '../lib/nav';

function UserMenu() {
  const { authEnabled, user, logout, canWrite } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!authEnabled || !user) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="user-menu" role="group" aria-label="Account">
      <span className="max-w-[7rem] truncate text-sm font-medium sm:max-w-[12rem]" data-testid="user-menu-username" title={user.username}>{user.username}</span>
      <span data-testid="user-menu-role"><Badge tone={user.role === 'ADMIN' ? 'purple' : 'amber'}>{user.role}</Badge></span>
      {!canWrite && <span data-testid="readonly-badge"><Badge tone="amber">read-only</Badge></span>}
      <Link to="/account" data-testid="account-link"
        className="rounded-md border border-slate-300 px-2.5 py-1 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">Account</Link>
      <button type="button" data-testid="logout-button" disabled={busy}
        className="rounded-md border border-slate-300 px-2.5 py-1 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
        onClick={async () => { setBusy(true); try { await logout(); } finally { setBusy(false); } }}>
        Log out
      </button>
    </div>
  );
}

function useIsDesktop(): boolean {
  const q = '(min-width: 768px)';
  const [v, setV] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setV(m.matches);
    m.addEventListener('change', on);
    on();
    return () => m.removeEventListener('change', on);
  }, []);
  return v;
}

const COLLAPSE_KEY = 'nav-collapsed';
function loadCollapsed(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
}

function setInert(el: HTMLElement | null, on: boolean) { if (el) el.toggleAttribute('inert', on); }

export default function Layout() {
  const { authEnabled, canWrite } = useAuth();
  const loc = useLocation();
  const isDesktop = useIsDesktop();
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const asideRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
  }, [dark]);

  // route changes close the mobile drawer
  useEffect(() => { setOpen(false); }, [loc.pathname]);

  // the drawer behaves as a modal on small screens: the rest of the page is inert while it is open, Esc closes it,
  // and while it is closed (off-canvas) its links are not reachable by keyboard
  const drawerOpen = open && !isDesktop;
  useEffect(() => {
    setInert(headerRef.current, drawerOpen);
    setInert(mainRef.current, drawerOpen);
    setInert(asideRef.current, !isDesktop && !open);
    if (drawerOpen) {
      const first = asideRef.current?.querySelector<HTMLElement>('a,button');
      first?.focus();
    } else if (wasOpen.current) menuBtnRef.current?.focus();
    wasOpen.current = drawerOpen;
  }, [drawerOpen, isDesktop, open]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // sticky page headers sit just under the app header, whatever height it wraps to
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty('--app-header-h', `${el.offsetHeight}px`);
    set();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : undefined;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const toggleSection = useCallback((id: string) => {
    setCollapsed(c => {
      const next = { ...c, [id]: !c[id] };
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const pageLabel = titleForPath(loc.pathname).split(' - ')[0];

  return (
    <div className="flex min-h-screen">
      <a href="#main-content" data-testid="skip-link"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-brand-600 focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-white">
        Skip to main content
      </a>
      <aside ref={asideRef} className={`fixed inset-y-0 left-0 z-30 w-60 transform overflow-y-auto border-r border-slate-200 bg-white transition-transform dark:border-slate-800 dark:bg-slate-900 md:static md:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`} data-testid="sidebar">
        <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-4 dark:border-slate-800">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-sm font-bold text-white" aria-hidden="true">S</div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Spend Guard Lite</div>
            <div className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400">Demo / Simulated</div>
          </div>
        </div>
        <nav id="app-sidebar-nav" aria-label="Primary" className="space-y-2 p-2">
          {NAV_SECTIONS.map(section => {
            const hasActive = section.items.some(i => (i.end ? loc.pathname === i.to : loc.pathname === i.to || loc.pathname.startsWith(`${i.to}/`)));
            const isCollapsed = !!collapsed[section.id] && !hasActive;
            const listId = `nav-section-${section.id}`;
            return (
              <div key={section.id} data-testid={`nav-section-${section.id}`}>
                <button type="button" onClick={() => toggleSection(section.id)} aria-expanded={!isCollapsed} aria-controls={listId}
                  className="flex w-full items-center justify-between rounded px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
                  {section.label}
                  <span aria-hidden="true" className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`}>▾</span>
                </button>
                <ul id={listId} hidden={isCollapsed} className="mt-0.5 space-y-0.5">
                  {section.items.map(n => (
                    <li key={n.to}>
                      <NavLink
                        to={n.to}
                        end={n.end}
                        onClick={() => setOpen(false)}
                        className={({ isActive }) =>
                          `block rounded-md px-3 py-2 text-sm font-medium ${isActive ? 'bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-100' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`
                        }
                      >
                        {n.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
      </aside>
      {open && <div className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={() => setOpen(false)} aria-hidden="true" />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header ref={headerRef} role="banner" className="sticky top-0 z-10 flex min-h-14 items-center justify-between gap-2 border-b border-slate-200 bg-white/80 px-4 py-1 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
          <button ref={menuBtnRef} type="button" className="rounded p-2 md:hidden" aria-label="Open menu" aria-expanded={open} aria-controls="app-sidebar-nav" onClick={() => setOpen(o => !o)}>☰</button>
          <div className="hidden text-xs text-amber-800 dark:text-amber-300 md:block" data-testid="sim-banner">
            All provider traffic is local, simulated mock data - no external AI requests are ever made.
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
            <span data-testid="sim-badge"><Badge tone="amber">DEMO / SIMULATED</Badge></span>
            <UserMenu />
            <button
              type="button"
              className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              onClick={() => setDark(d => !d)}
              aria-label="Toggle theme"
              data-testid="theme-toggle"
            >
              {dark ? 'Light' : 'Dark'} mode
            </button>
          </div>
        </header>
        <main id="main-content" ref={mainRef} tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none md:p-6" aria-label={pageLabel}>
          {authEnabled && !canWrite && (
            <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" role="status" data-testid="readonly-banner">
              Read-only account: you can view all data, but changes are disabled for your role.
            </div>
          )}
          <ErrorBoundary scope="page" resetKey={loc.pathname}>
            <Suspense fallback={<Loading variant="lines" label="Loading page..." />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
        <div aria-live="polite" className="sr-only" data-testid="route-announcer">{pageLabel}</div>
      </div>
    </div>
  );
}
