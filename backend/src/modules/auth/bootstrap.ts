import type { PrismaClient } from '@prisma/client';
import type { Instrumentation } from '../../contracts/instrumentation';
import { hashPassword, validatePassword, isValidUsername, normalizeUsername } from '../../utils/password';
import { createFirstAdmin } from './users';

export type BootstrapResult = { status: 'created' | 'exists' | 'skipped'; username?: string };

/**
 * Creates the first ADMIN from ADMIN_USERNAME / ADMIN_PASSWORD when (and only when) no users exist. Idempotent:
 * never overwrites or resets an existing user. Throws (without echoing the password) when the configured credentials violate the policy.
 */
export async function bootstrapAdmin(
  prisma: PrismaClient,
  env: Record<string, string | undefined> = process.env,
  instr?: Instrumentation,
): Promise<BootstrapResult> {
  const rawUser = env.ADMIN_USERNAME?.trim();
  const password = env.ADMIN_PASSWORD;
  if (!rawUser || !password) return { status: 'skipped' };
  if ((await prisma.user.count()) > 0) return { status: 'exists' };
  const username = normalizeUsername(rawUser);
  if (!isValidUsername(username)) throw new Error('ADMIN_USERNAME is invalid: use 3-32 characters from a-z, 0-9, dot, underscore, hyphen.');
  const problems = validatePassword(password, username);
  if (problems.length) throw new Error(`ADMIN_PASSWORD rejected: ${problems.join(' ')}`);
  const created = await createFirstAdmin(prisma, username, await hashPassword(password));
  if (!created) return { status: 'exists' };
  await instr?.recordActivity({
    type: 'auth.setup', level: 'INFO', source: 'ACTUAL', message: `Initial admin "${username}" created from environment`,
    metadata: { username, userId: created.id, via: 'bootstrap' },
  }).catch(() => undefined);
  return { status: 'created', username };
}
