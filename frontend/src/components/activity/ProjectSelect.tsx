import type { ProjectWithUsage } from '@shared/types';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useApi';
import { SelectFilter } from '../observability/common';

/** Project filter backed by /projects. Falls back to an empty list if the call fails. */
export function useProjects() {
  const s = useAsync(async () => (await api.list<ProjectWithUsage>('/projects', { includeTest: true, pageSize: 200 })).data, []);
  return s.data ?? [];
}

export default function ProjectSelect({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId?: string }) {
  const projects = useProjects();
  return <SelectFilter label="Project" value={value} onChange={onChange} testId={testId} options={projects.map(p => ({ value: p.id, label: p.name }))} />;
}
