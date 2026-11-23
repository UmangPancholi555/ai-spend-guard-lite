/**
 * Non-interactive account administration (works offline, directly on the database - the recovery path when everyone is locked out):
 *   USERNAME=alice PASSWORD='long passphrase here' npm run user:create            (ROLE=ADMIN|VIEWER, default ADMIN)
 *   USERNAME=alice npm run user:unlock                                            (clears failed-attempt counters / lock)
 *   USERNAME=alice NEW_PASSWORD='another long passphrase' npm run user:reset-password   (also signs the user out everywhere)
 * Secrets come from env (PASSWORD / NEW_PASSWORD), stdin (--password-stdin) or --password / --new-password (discouraged: visible in
 * `ps`/shell history). They are never echoed or logged. Exit code 0 on success, 1 on any failure.
 * Note: a running server also keeps per-(user, IP) locks in memory; those expire on their own (15 min) or on restart.
 */
import fs from 'node:fs';
import { createPrisma } from '../../database/client';
import { createUser, resetUserPassword, unlockUser, UserInputError } from './users';
import { createInstrumentation } from '../instrumentation';
import { loadConfig } from '../../config';
import type { UserRole } from '../../../../shared/auth';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find(a => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`);

function secret(envName: string, argName: string): string | undefined {
  if (flag('password-stdin')) return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  const fromArg = arg(argName);
  if (fromArg !== undefined) {
    console.error(`warning: --${argName} is visible in process listings and shell history; prefer env ${envName} or --password-stdin.`);
    return fromArg;
  }
  return process.env[envName];
}

async function audit(prisma: ReturnType<typeof createPrisma>, type: string, message: string, metadata: Record<string, unknown>) {
  try {
    const instr = createInstrumentation(prisma, { logDir: loadConfig().logDir });
    await instr.recordActivity({ type, level: 'INFO', source: 'ACTUAL', message, metadata: { ...metadata, via: 'cli' } });
  } catch { /* auditing is best effort offline */ }
}

async function main() {
  const first = process.argv[2];
  const command = first && !first.startsWith('--') ? first : 'create';
  const username = arg('username') ?? process.env.USERNAME;
  if (!username) throw new UserInputError('Provide USERNAME (env) or --username.');
  const prisma = createPrisma();
  try {
    if (command === 'create') {
      const password = secret('PASSWORD', 'password');
      const role = (arg('role') ?? process.env.ROLE ?? 'ADMIN').toUpperCase();
      if (!password) throw new UserInputError('Provide PASSWORD (env) or --password-stdin.');
      if (role !== 'ADMIN' && role !== 'VIEWER') throw new UserInputError('ROLE must be ADMIN or VIEWER.');
      const u = await createUser(prisma, username, password, role as UserRole);
      await audit(prisma, 'auth.user.created', `User "${u.username}" created`, { targetUsername: u.username, targetUserId: u.id, role: u.role });
      console.log(`Created ${u.role} user "${u.username}" (id ${u.id}).`);
    } else if (command === 'unlock') {
      const u = await unlockUser(prisma, username);
      await audit(prisma, 'auth.user.updated', `User "${u.username}" unlocked`, { targetUsername: u.username, targetUserId: u.id, changes: ['unlock'] });
      console.log(`Unlocked user "${u.username}".`);
    } else if (command === 'reset-password') {
      const password = secret('NEW_PASSWORD', 'new-password');
      if (!password) throw new UserInputError('Provide NEW_PASSWORD (env) or --password-stdin.');
      const u = await resetUserPassword(prisma, username, password);
      await audit(prisma, 'auth.user.updated', `Password reset for "${u.username}"`, { targetUsername: u.username, targetUserId: u.id, changes: ['password', 'unlock'] });
      console.log(`Password reset for "${u.username}"; all of their sessions were revoked.`);
    } else {
      throw new UserInputError(`Unknown command "${command}" (use create | unlock | reset-password).`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(e => {
  const msg = e instanceof UserInputError ? e.message : e instanceof Error && e.message === 'exists' ? 'That username already exists.' : 'Operation failed.';
  console.error(`user command failed: ${msg}`);
  process.exit(1);
});
