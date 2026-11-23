import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AuthSessionInfoDto, AuthStatusDto, AuthUserDto } from '@shared/auth';
import { api, authBridge } from '../../lib/api';

export interface AuthContextValue {
  /** true until the first /auth/status answer arrived */
  loading: boolean;
  /** set when /auth/status itself failed (server down) */
  error?: string;
  authEnabled: boolean;
  setupRequired: boolean;
  user: AuthUserDto | null;
  isAdmin: boolean;
  /** false for VIEWER accounts (the server enforces this; the UI uses it to hide/disable mutating controls) */
  canWrite: boolean;
  login(username: string, password: string): Promise<void>;
  setup(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}

interface State { loading: boolean; error?: string; authEnabled: boolean; setupRequired: boolean; user: AuthUserDto | null }

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  // authEnabled defaults to false so that nothing is gated until the server says otherwise (guard waits on `loading`)
  const [s, setS] = useState<State>({ loading: true, authEnabled: false, setupRequired: false, user: null });

  const refresh = useCallback(async () => {
    try {
      const st = await api.get<AuthStatusDto>('/auth/status');
      let user: AuthUserDto | null = null;
      if (st.authEnabled && st.authenticated && st.user) {
        const me = await api.get<AuthSessionInfoDto>('/auth/me');
        authBridge.setCsrfToken(me.csrfToken);
        user = me.user;
      } else {
        authBridge.setCsrfToken(undefined);
      }
      setS({ loading: false, authEnabled: st.authEnabled, setupRequired: st.setupRequired, user });
    } catch (e) {
      setS(p => ({ ...p, loading: false, error: (e as Error).message || 'Unable to reach the server' }));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // any 401 UNAUTHENTICATED from the API clears the local session; <RequireAuth> then redirects once to /login?next=...
  useEffect(() => {
    authBridge.onUnauthorized(() => setS(p => (p.user ? { ...p, user: null } : p)));
    return () => authBridge.onUnauthorized(undefined);
  }, []);

  const adopt = useCallback((r: AuthSessionInfoDto) => {
    authBridge.setCsrfToken(r.csrfToken);
    setS(p => ({ ...p, loading: false, error: undefined, setupRequired: false, user: r.user }));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    adopt(await api.post<AuthSessionInfoDto>('/auth/login', { username, password }));
  }, [adopt]);

  const setup = useCallback(async (username: string, password: string) => {
    adopt(await api.post<AuthSessionInfoDto>('/auth/setup', { username, password }));
  }, [adopt]);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* already logged out / network: clear locally anyway */ }
    authBridge.setCsrfToken(undefined);
    navigate('/login', { replace: true });
    setS(p => ({ ...p, user: null }));
  }, [navigate]);

  const value = useMemo<AuthContextValue>(() => ({
    ...s,
    isAdmin: s.user?.role === 'ADMIN',
    canWrite: !s.authEnabled || s.user?.role === 'ADMIN',
    login, setup, logout, refresh,
  }), [s, login, setup, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
