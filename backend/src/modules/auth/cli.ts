/**
 * Non-interactive user creation:
 *   USERNAME=alice PASSWORD='long passphrase here' npm run user:create
 *   npm run user:create -- --username alice --role VIEWER --password-stdin < pw.txt
 * The password is read from env PASSWORD, stdin (--password-stdin) or --password (discouraged: visible in `ps`/shell history).
 * It is never echoed or logged. Exit code 0 on success, 1 on any failure.
 */
import fs from 'node:fs';
import { createPrisma } from '../../database/client';
import { createUser, UserInputError } from './users';
import type { UserRole } from '../../../../shared/auth';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find(a => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`);

async function main() {
  const username = arg('username') ?? process.env.USERNAME;
  let password = process.env.PASSWORD;
  if (flag('password-stdin')) password = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  else if (arg('password') !== undefined) {
    password = arg('password');
    console.error('warning: --password is visible in process listings and shell history; prefer env PASSWORD or --password-stdin.');
  }
  const role = (arg('role') ?? process.env.ROLE ?? 'ADMIN').toUpperCase();
  if (!username || !password) throw new UserInputError('Provide USERNAME and PASSWORD (env), or --username with --password-stdin.');
  if (role !== 'ADMIN' && role !== 'VIEWER') throw new UserInputError('ROLE must be ADMIN or VIEWER.');
  const prisma = createPrisma();
  try {
    const u = await createUser(prisma, username, password, role as UserRole);
    console.log(`Created ${u.role} user "${u.username}" (id ${u.id}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(e => {
  const msg = e instanceof UserInputError ? e.message : e instanceof Error && e.message === 'exists' ? 'That username already exists.' : 'Failed to create user.';
  console.error(`user:create failed: ${msg}`);
  process.exit(1);
});
