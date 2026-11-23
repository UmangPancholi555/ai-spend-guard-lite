/** Auth contracts shared by backend (modules/auth) and frontend. All responses use the `{ data }` envelope. */
export type UserRole = 'ADMIN' | 'VIEWER';

export interface AuthUserDto {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
}

/** GET /api/auth/status (public) */
export interface AuthStatusDto {
  authEnabled: boolean;
  /** true while zero users exist (first-run: POST /auth/setup) */
  setupRequired: boolean;
  authenticated: boolean;
  user?: AuthUserDto;
}

/** GET /api/auth/me, POST /auth/login, POST /auth/setup */
export interface AuthSessionInfoDto {
  user: AuthUserDto;
  /** send as `X-CSRF-Token` on every non-GET request */
  csrfToken: string;
}

/** GET /api/auth/users (ADMIN) */
export interface ManagedUserDto extends AuthUserDto {
  failedAttempts: number;
  lockedUntil: string | null;
  locked: boolean;
  activeSessions: number;
}

/** GET /api/auth/sessions (own sessions) - never contains tokens or hashes */
export interface UserSessionDto {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface LoginInput { username: string; password: string }
export interface SetupInput { username: string; password: string }
export interface ChangePasswordInput { currentPassword: string; newPassword: string }
export interface CreateUserInput { username: string; password: string; role: UserRole }
export interface UpdateUserInput { role?: UserRole; password?: string; unlock?: boolean }

export const USERNAME_RULE = '3-32 characters: lowercase letters, digits, dot, underscore, hyphen';
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
