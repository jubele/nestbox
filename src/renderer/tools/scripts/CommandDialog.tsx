import { useState } from 'react';
import { formatCommandLine, splitCommandLine } from '@shared/command-line';
import { COMMAND_NAME } from '@shared/detected';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useCommandActions, usePythonFiles } from './use-scripts';

/** A command name from a file path: `app/run server.py` → `run-server`. */
function nameFromFile(path: string): string {
  const stem = (path.split('/').pop() ?? path).replace(/\.py$/, '');
  return stem
    .replace(/[^A-Za-z0-9:._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 60);
}

/** Adds a custom command to a package, or edits one (`initial`). Mounted only while open. */
export function CommandDialog({
  projectId,
  initial,
  onOpenChange,
}: {
  projectId: string;
  /** `command` is the line the Scripts list shows, which splits back to the same arguments. */
  initial: { name: string; command: string } | null;
  onOpenChange(open: boolean): void;
}) {
  const { save } = useCommandActions(projectId);
  const [name, setName] = useState(initial?.name ?? '');
  const [line, setLine] = useState(initial?.command ?? '');
  const { data: python } = usePythonFiles(projectId);
  const [pickedFile, setPickedFile] = useState('');
  const pickFile = (file: string) => {
    setPickedFile(file);
    if (file === '') return;
    setLine(formatCommandLine(['python', file]));
    // The name follows the file until the user types one.
    if (name === '' || name === nameFromFile(pickedFile)) setName(nameFromFile(file));
  };
  const nameError =
    name !== '' && !COMMAND_NAME.test(name)
      ? 'Use letters, digits, ":", ".", "_" or "-" (up to 60).'
      : null;
  const split = line.trim() === '' ? null : splitCommandLine(line);
  const canSave = name !== '' && nameError === null && split?.ok === true && !save.isPending;

  return (
    <Dialog open onOpenChange={(open) => !save.isPending && onOpenChange(open)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit command' : 'Add command'}</DialogTitle>
          <DialogDescription>
            A program and its arguments, run in this package's folder without a shell: &&, | and
            &gt; are passed as they are. In a Python package, python and the tools in its virtualenv
            come first.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSave || !split?.ok) return;
            save.mutate(
              { ...(initial ? { previousName: initial.name } : {}), name, argv: split.argv },
              { onSuccess: () => onOpenChange(false) },
            );
          }}
        >
          {python && python.files.length > 0 && (
            <label className="block space-y-1 text-xs text-fg-muted">
              <span>Run a Python file</span>
              <select
                aria-label="Python file"
                value={pickedFile}
                onChange={(e) => pickFile(e.target.value)}
                className="h-8 w-full rounded-md border border-line bg-app px-2 font-mono text-xs text-fg"
              >
                <option value="">Choose a file…</option>
                {python.files.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block space-y-1 text-xs text-fg-muted">
            <span>Name</span>
            <Input
              aria-label="Name"
              value={name}
              maxLength={60}
              placeholder="api"
              autoFocus={!initial}
              onChange={(e) => setName(e.target.value)}
              className="h-8 font-mono text-sm"
            />
            {nameError && <span className="block text-err">{nameError}</span>}
          </label>
          <label className="block space-y-1 text-xs text-fg-muted">
            <span>Command</span>
            <Input
              aria-label="Command"
              value={line}
              placeholder="uvicorn app.main:app --reload --port 8000"
              autoFocus={initial !== null}
              onChange={(e) => setLine(e.target.value)}
              className="h-8 font-mono text-sm"
            />
            {split?.ok === false && <span className="block text-err">{split.error}</span>}
            {split?.ok && (
              <span className="block">
                Runs <code className="font-mono text-fg">{split.argv[0]}</code>
                {split.argv.length > 1 &&
                  ` with ${split.argv.length - 1} ${split.argv.length === 2 ? 'argument' : 'arguments'}`}
              </span>
            )}
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
