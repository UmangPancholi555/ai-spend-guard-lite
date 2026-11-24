import { useState, type FormEvent } from 'react';
import type { ProjectDto } from '@shared/types';
import { Button, inputCls } from '../ui/Button';
import { errMessage } from './util';
import { useReadOnly } from '../auth/readOnly';

export interface ProjectFormValues { name: string; description: string; isTest: boolean }

/** Create/edit form. Surfaces API validation (400) and conflict (409) messages inline. */
export default function ProjectForm({ initial, mode, onSubmit, onCancel }: {
  initial?: Pick<ProjectDto, 'name' | 'description' | 'isTest'>;
  mode: 'create' | 'edit';
  onSubmit: (v: ProjectFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [isTest, setIsTest] = useState(initial?.isTest ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [nameErr, setNameErr] = useState<string>();
  const { readOnly, guard } = useReadOnly();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (readOnly) return;
    const trimmed = name.trim();
    if (!trimmed) { setNameErr('Name is required.'); return; }
    if (trimmed.length > 80) { setNameErr('Name must be 80 characters or fewer.'); return; }
    setNameErr(undefined); setError(undefined); setBusy(true);
    try { await onSubmit({ name: trimmed, description: description.trim(), isTest }); }
    catch (err) { setError(errMessage(err)); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate data-testid="project-form">
      <div>
        <label htmlFor="project-name" className="mb-1 block text-sm font-medium">Name</label>
        <input id="project-name" className={`${inputCls} w-full`} value={name} onChange={e => setName(e.target.value)} onBlur={() => setNameErr(name.trim() ? (name.trim().length > 80 ? 'Name must be 80 characters or fewer.' : undefined) : 'Name is required.')} maxLength={200}
          aria-invalid={!!nameErr} aria-describedby={nameErr ? 'project-name-err' : undefined} autoFocus data-testid="project-name-input" />
        {nameErr && <p id="project-name-err" className="mt-1 text-xs text-red-700 dark:text-red-400" data-testid="project-name-error">{nameErr}</p>}
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">1-80 characters, unique (case-insensitive).</p>
      </div>
      <div>
        <label htmlFor="project-desc" className="mb-1 block text-sm font-medium">Description (optional)</label>
        <textarea id="project-desc" className={`${inputCls} w-full`} rows={3} maxLength={1000} value={description} onChange={e => setDescription(e.target.value)} data-testid="project-description-input" />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={isTest} onChange={e => setIsTest(e.target.checked)} data-testid="project-test-checkbox" />
        <span>Test project <span className="block text-xs text-slate-600 dark:text-slate-400">Only test projects can be deleted.</span></span>
      </label>
      {error && <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200" data-testid="project-form-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy} data-testid="project-form-cancel">Cancel</Button>
        <Button type="submit" {...guard(busy)} data-testid={mode === 'create' ? 'project-create-submit' : 'project-edit-submit'}>
          {busy ? 'Saving...' : mode === 'create' ? 'Create project' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
