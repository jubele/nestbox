import { useState } from 'react';
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

/** The env tool's key pattern (EnvKeySchema). */
const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const NEW_ENV = '.env';

interface Props {
  /** The package's env files; read-only ones are left out. */
  files: { name: string; readOnly: boolean }[];
  has(file: string, key: string): boolean;
  /** Names the code reads that no file has yet. */
  suggestions: string[];
  onClose(): void;
  onSave(input: { file: string; key: string; value: string }): void;
}

/** A new key in an env file of the user's choice; a package without .env gets a new one. Mounted while open. */
export function AddVariableDialog({ files, has, suggestions, onClose, onSave }: Props) {
  const writable = files.filter((f) => !f.readOnly).map((f) => f.name);
  // A symlinked .env exists but is read-only: it is neither offered nor created.
  const options = files.some((f) => f.name === NEW_ENV) ? writable : [NEW_ENV, ...writable];
  const [file, setFile] = useState(options.includes(NEW_ENV) ? NEW_ENV : (options[0] ?? ''));
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const error =
    key === ''
      ? null
      : !KEY.test(key) || key.length > 200
        ? 'Letters, digits, "_", "." or "-", not starting with a digit.'
        : has(file, key)
          ? `${file} already has ${key}: edit it in the table.`
          : null;
  const canSave = file !== '' && key !== '' && error === null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add variable</DialogTitle>
          <DialogDescription>Comments and the rest of the file stay as they are.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) onSave({ file, key, value });
          }}
        >
          <label className="block space-y-1 text-xs text-fg-muted">
            <span>File</span>
            <select
              aria-label="File"
              value={file}
              onChange={(e) => setFile(e.target.value)}
              className="h-8 w-full rounded-md border border-line bg-app px-2 font-mono text-xs text-fg"
            >
              {options.map((name) => (
                <option key={name} value={name}>
                  {writable.includes(name) ? name : `${name} (new file)`}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs text-fg-muted">
            <span>Key</span>
            <Input
              aria-label="Key"
              value={key}
              autoFocus
              list="nestbox-env-key-suggestions"
              spellCheck={false}
              onChange={(e) => setKey(e.target.value.trim())}
              className="h-8 font-mono text-sm"
            />
            <datalist id="nestbox-env-key-suggestions">
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            {error && <span className="block text-err">{error}</span>}
          </label>
          <textarea
            aria-label="Value"
            value={value}
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            rows={3}
            className="w-full resize-y rounded-md border border-line bg-app px-2 py-1.5 font-mono text-xs text-fg outline-none focus-visible:border-brand"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
