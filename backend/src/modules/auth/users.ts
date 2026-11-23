import { randomBytes } from 'node:crypto';
import type { PrismaClient, User } from '@prisma/client';
import type { AuthUserDto, UserRole } from '../../../../shared/auth';
import { hashPassword, validatePassword, isValidUsername, normalizeUsername } from '../../utils/password';

export function toUserDto(u: Pick<User, 'id' | 'username' | 'role' | 'createdAt' | 'lastLoginAt'>): AuthUserDto {
  return {
    id: u.id, username: u.username, role: u.role === 'VIEWER' ? 'VIEWER' : 'ADMIN',
    createdAt: u.createdAt.toISOString(), lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
  };
}

const newUserId = () => `c${randomBytes(12).toString('hex')}`;

/**
 * Creates the FIRST user as ADMIN in one atomic statement: the INSERT only happens when the User table is empty,
 * so concurrent callers (HTTP setup race, bootstrap + setup, two processes) cannot both succeed.
 * Returns the created user or null when users already exist.
 */
export async function createFirstAdmin(prisma: PrismaClient, username: string, passwordHash: string): Promise<AuthUserDto | null> {
  const id = newUserId();
  const now = new Date();
  const n = await prisma.$executeRaw`
    INSERT INTO "User" ("id","username","passwordHash","role","failedAttempts","createdAt","updatedAt")
    SELECT ${id}, ${username}, ${passwordHash}, 'ADMIN', 0, ${now}, ${now}
    WHERE NOT EXISTS (SELECT 1 FROM "User")`;
  if (n !== 1) return null;
  const u = await prisma.user.findUnique({ where: { id } });
  return u ? toUserDto(u) : null;
}

export class UserInputError extends Error {}

/** Validates + creates a user (any role). Throws UserInputError on policy violations, Error('exists') on duplicate. */
export async function createUser(prisma: PrismaClient, rawUsername: string, password: string, role: UserRole): Promise<AuthUserDto> {
  const username = normalizeUsername(rawUsername);
  if (!isValidUsername(username)) throw new UserInputError('Username must be 3-32 characters: lowercase letters, digits, dot, underscore, hyphen.');
  const problems = validatePassword(password, username);
  if (problems.length) throw new UserInputError(problems.join(' '));
  const passwordHash = await hashPassword(password);
  try {
    const u = await prisma.user.create({ data: { id: newUserId(), username, passwordHash, role } });
    return toUserDto(u);
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new Error('exists');
    throw new Error('user create failed'); // never propagate prisma errors: they can echo the hash in their message
  }
}

/** Offline/CLI helpers (also usable from tests). They never throw prisma errors upward (those can echo hashes). */
export async function unlockUser(prisma: PrismaClient, rawUsername: string): Promise<AuthUserDto> {
  const username = normalizeUsername(rawUsername);
  const u = await prisma.user.findUnique({ where: { username } });
  if (!u) throw new UserInputError('No such user.');
  const upd = await prisma.user.update({ where: { id: u.id }, data: { failedAttempts: 0, lockedUntil: null } });
  return toUserDto(upd);
}

/** Policy-checked password reset; revokes every session of the user and clears the lock. */
export async function resetUserPassword(prisma: PrismaClient, rawUsername: string, newPassword: string): Promise<AuthUserDto> {
  const username = normalizeUsername(rawUsername);
  const u = await prisma.user.findUnique({ where: { username } });
  if (!u) throw new UserInputError('No such user.');
  const problems = validatePassword(newPassword, username);
  if (problems.length) throw new UserInputError(problems.join(' '));
  const passwordHash = await hashPassword(newPassword);
  const upd = await prisma.user.update({ where: { id: u.id }, data: { passwordHash, failedAttempts: 0, lockedUntil: null } });
  await prisma.session.deleteMany({ where: { userId: u.id } });
  return toUserDto(upd);
}
