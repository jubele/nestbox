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
import { useCommandActions, useRunnableFiles } from './use-scripts';

/** A command name from a file path: `app/run server.py` → `run-server`. */
function nameFromFile(path: string): string {
  const stem = (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
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
  initial: { name: string; command: string; main?: boolean } | null;
  onOpenChange(open: boolean): void;
}) {
  const { save } = useCommandActions(projectId);
  const [name, setName] = useState(initial?.name ?? '');
  const [line, setLine] = useState(initial?.command ?? '');
  const { data: runnable } = useRunnableFiles(projectId);
  const files = runnable?.files ?? [];
  const [pickedFile, setPickedFile] = useState('');
  const pickFile = (path: string) => {
    setPickedFile(path);
    const file = files.find((f) => f.path === path);
    if (!file) return;
    setLine(formatCommandLine(file.argv));
    // The name follows the file until the user types one.
    if (name === '' || name === nameFromFile(pickedFile)) setName(nameFromFile(path));
  };
  const [main, setMain] = useState(initial?.main ?? false);
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
            &gt; are passed as they are.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSave || !split?.ok) return;
            save.mutate(
              { ...(initial ? { previousName: initial.name } : {}), name, argv: split.argv, main },
              { onSuccess: () => onOpenChange(false) },
            );
          }}
        >
          {files.length > 0 && (
            <label className="block space-y-1 text-xs text-fg-muted">
              <span>Run a file</span>
              <select
                aria-label="File to run"
                value={pickedFile}
                onChange={(e) => pickFile(e.target.value)}
                className="h-8 w-full rounded-md border border-line bg-app px-2 font-mono text-xs text-fg"
              >
                <option value="">Choose a file…</option>
                {files.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.path}
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
              placeholder="node server.js --port 8000"
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
          <label className="flex items-center gap-2 text-xs text-fg">
            <input
              type="checkbox"
              className="accent-brand"
              checked={main}
              onChange={(e) => setMain(e.target.checked)}
            />
            Main command of this package
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
