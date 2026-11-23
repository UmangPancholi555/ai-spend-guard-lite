import type { ActivityEvent, Project } from '@prisma/client';
import type { ActivityEventDto, ProjectDto, ProjectStatus, Source } from '../../../../shared/types';
import { parseJson } from '../../utils/serialize';

export function toProjectDto(p: Project): ProjectDto {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status as ProjectStatus,
    isTest: p.isTest,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    archivedAt: p.archivedAt ? p.archivedAt.toISOString() : null,
  };
}

export function toActivityDto(a: ActivityEvent & { project?: { name: string } | null }): ActivityEventDto {
  return {
    id: a.id,
    type: a.type,
    level: a.level as ActivityEventDto['level'],
    message: a.message,
    source: a.source as Source,
    projectId: a.projectId,
    projectName: a.project ? a.project.name : null,
    traceId: a.traceId,
    requestId: a.requestId,
    metadata: parseJson(a.metadata),
    createdAt: a.createdAt.toISOString(),
  };
}
