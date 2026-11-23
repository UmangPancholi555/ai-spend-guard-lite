// STUB - owned by the usage module agent. Keep this exported factory signature.
import { Router } from 'express';
import type { AppDeps } from '../../contracts/services';

export function createUsageRouter(_deps: AppDeps): Router {
  return Router();
}
