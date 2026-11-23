// STUB - owned by the traces module agent. Keep this exported factory signature.
import { Router } from 'express';
import type { AppDeps } from '../../contracts/services';

export function createTracesRouter(_deps: AppDeps): Router {
  return Router();
}
