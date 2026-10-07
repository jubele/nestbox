import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePythonEnvs, useSetVenv } from './use-scripts';

export interface PythonChoice {
  choice: 'auto' | 'none' | 'path';
  /** In use: from the project folder (posix) or absolute; null = system Python. */
  venv: string | null;
  /** What Auto finds. */
  auto: string | null;
}

/**
 * Which virtualenv a Python package's commands run in: the detected one, one found in the project, system
 * Python, or a folder typed in (main checks it holds a pyvenv.cfg). Applies from the next start.
 */
export function PythonEnvPicker({
  projectId,
  python,
}: {
  projectId: string;
  python: PythonChoice;
}) {
  const { data } = usePythonEnvs(projectId, true);
  const setVenv = useSetVenv(projectId);
  const [other, setOther] = useState(false);
  const [path, setPath] = useState('');
  const current = python.choice === 'path' ? (python.venv ?? '') : python.choice;
  const found = data?.envs ?? [];
  const paths =
    python.choice === 'path' && python.venv !== null && !found.includes(python.venv)
      ? [python.venv, ...found]
      : found;

  return (
    <div className="mb-3 space-y-1.5 rounded-md border border-line bg-card px-3 py-2 text-xs">
      <label className="flex items-center gap-2">
        <span className="shrink-0 text-fg-muted">Python environment</span>
        <select
          aria-label="Python environment"
          value={other ? 'other' : current}
          disabled={setVenv.isPending}
          onChange={(e) => {
            const value = e.target.value;
            setOther(value === 'other');
            if (value === 'other') return;
            if (value === 'auto' || value === 'none') setVenv.mutate({ mode: value });
            else setVenv.mutate({ mode: 'path', path: value });
          }}
          className="h-6 min-w-0 flex-1 rounded border border-line bg-app px-1 font-mono text-[11px] text-fg"
        >
          <option value="auto">Auto: {python.auto ?? 'none found'}</option>
          {paths.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
          <option value="none">System Python (no virtualenv)</option>
          <option value="other">Other folder…</option>
        </select>
      </label>
      {other && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim() === '') return;
            setVenv.mutate(
              { mode: 'path', path: path.trim() },
              { onSuccess: () => setOther(false) },
            );
          }}
        >
          <Input
            aria-label="Virtualenv folder"
            value={path}
            autoFocus
            placeholder="/home/me/.virtualenvs/api or backend/.venv"
            onChange={(e) => setPath(e.target.value)}
            className="h-7 font-mono text-xs"
          />
          <Button type="submit" size="sm" disabled={path.trim() === '' || setVenv.isPending}>
            Use
          </Button>
        </form>
      )}
    </div>
  );
}
