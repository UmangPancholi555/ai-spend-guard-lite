import type { UserRole } from '../../../../shared/auth';

export interface AuthUser { id: string; username: string; role: UserRole }
export interface AuthSessionRef { id: string; csrfHash: string }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** set by requireAuth / the auth router gate once a valid session is found */
      user?: AuthUser;
      authSession?: AuthSessionRef;
    }
  }
}
