import fs from 'node:fs';
import { E2E_DIR } from './env';
import { stopServer } from './server';

export default async function globalTeardown() {
  await stopServer();
  if (process.env.E2E_KEEP !== '1') fs.rmSync(E2E_DIR, { recursive: true, force: true });
}
