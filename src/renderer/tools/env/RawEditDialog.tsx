import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { NestboxError } from '@shared/errors';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { envMatrixKey } from './use-env';

/**
 * One env file as text (every value shown: the user asked for it). Saving sends the version it was read at,
 * so a change on disk meanwhile is refused and the edits stay in the editor. Mounted only while open.
 */
export function RawEditDialog({
  projectId,
  file,
  readOnly,
  onClose,
}: {
  projectId: string;
  file: string;
  readOnly: boolean;
  onClose(): void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const raw = await api.tools.invoke('env', projectId, 'readRaw', { file });
      setText(raw.text);
      setVersion(raw.version);
      setStale(false);
    } catch (error) {
      toast.error(errorMessage(error));
      onClose();
    }
    // onClose is a fresh closure each render; loading depends on the file only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, file]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (text === null || version === null) return;
    setSaving(true);
    try {
      await api.tools.invoke('env', projectId, 'writeRaw', { file, text, version });
      await queryClient.invalidateQueries({ queryKey: envMatrixKey(projectId) });
      toast.success(`Saved ${file}`);
      onClose();
    } catch (error) {
      if (error instanceof NestboxError && error.code === 'CONFLICT') setStale(true);
      else toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{readOnly ? file : `Edit ${file}`}</DialogTitle>
          <DialogDescription>
            {readOnly
              ? 'A symlinked file: shown, not edited.'
              : 'The whole file, values included. Saving replaces it as written.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <textarea
            aria-label="File contents"
            value={text ?? ''}
            readOnly={readOnly}
            disabled={text === null}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            rows={16}
            className="w-full resize-y rounded-md border border-line bg-app px-2 py-1.5 font-mono text-xs text-fg outline-none focus-visible:border-brand"
          />
          {stale && (
            <p role="alert" className="flex items-center gap-2 text-xs text-warn">
              {file} changed on disk since you opened it. Your edits are still here; Reload replaces
              them.
              <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
                Reload
              </Button>
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
              {readOnly ? 'Close' : 'Cancel'}
            </Button>
            {!readOnly && (
              <Button type="submit" disabled={text === null || saving}>
                Save
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
