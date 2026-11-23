import { Router } from 'express';
import type { AppDeps } from '../../contracts/services';
import { ah, pageOf, parse } from '../../utils/http';
import { boundedPagination } from '../usage/pagination';
import { createProjectsService } from './service';
import { toActivityDto } from './mappers';
import { idParam, projectCreateSchema, projectListQuery, projectUpdateSchema } from './schemas';

export function createProjectsRouter(deps: AppDeps): Router {
  const router = Router();
  const svc = createProjectsService(deps);

  router.get('/projects', ah(async (req, res) => {
    const q = parse(projectListQuery, req.query);
    const { total, items } = await svc.list(q);
    res.json({ data: items, pagination: pageOf(total, q.page, q.pageSize) });
  }));

  router.post('/projects', ah(async (req, res) => {
    const body = parse(projectCreateSchema, req.body ?? {});
    res.status(201).json({ data: await svc.create(body) });
  }));

  router.get('/projects/:id', ah(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json({ data: await svc.get(id) });
  }));

  router.patch('/projects/:id', ah(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(projectUpdateSchema, req.body ?? {});
    res.json({ data: await svc.update(id, body) });
  }));

  router.post('/projects/:id/archive', ah(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json({ data: await svc.setArchived(id, true) });
  }));

  router.post('/projects/:id/unarchive', ah(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json({ data: await svc.setArchived(id, false) });
  }));

  router.delete('/projects/:id', ah(async (req, res) => {
    const { id } = parse(idParam, req.params);
    await svc.remove(id);
    res.status(204).end();
  }));

  router.get('/projects/:id/activity', ah(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { page, pageSize } = parse(boundedPagination, req.query);
    const { total, rows } = await svc.activity(id, page, pageSize);
    res.json({ data: rows.map(toActivityDto), pagination: pageOf(total, page, pageSize) });
  }));

  return router;
}
