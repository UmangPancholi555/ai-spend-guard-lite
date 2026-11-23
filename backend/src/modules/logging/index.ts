// STUB - owned by the logging module agent. Keep this exported factory signature.
import { Router } from 'express';
import type { AppDeps } from '../../contracts/services';

export function createLoggingRouter(_deps: AppDeps): Router {
  return Router();
}
