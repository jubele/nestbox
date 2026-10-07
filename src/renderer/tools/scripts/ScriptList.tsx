import { Pencil, Play, Plus, RotateCw, Square, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { isLive, type ProcessSummary } from '@shared/processes';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useProcesses } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/state/ui-store';
import type { ScriptInfo, ScriptKind } from '@shared/tools/scripts/contract';
import { CommandDialog } from './CommandDialog';
import { PythonEnvPicker } from './PythonEnvPicker';
import {
  useCommandActions,
  useScriptAction,
  useScriptList,
  useSetAutoRestart,
  useSetEnvFile,
  useSetMain,
} from './use-scripts';

const BADGES: Partial<Record<ProcessSummary['state'], string>> = {
  starting: 'border-warn/30 bg-warn/10 text-warn',
  stopping: 'border-warn/30 bg-warn/10 text-warn',
  running: 'border-ok/30 bg-ok/10 text-ok',
  crashed: 'border-err/30 bg-err/10 text-err',
  exited: 'border-line bg-surface text-fg-muted',
};

/** Where a row comes from, when it isn't package.json. */
const KIND_CHIPS: Partial<Record<ScriptKind, { label: string; title: string }>> = {
  detected: { label: 'detected', title: "Detected from the package's files (Python, .NET, …)" },
  custom: { label: 'custom', title: 'Added by you' },
};

function crashText(p: ProcessSummary): string | null {
  if (p.state !== 'crashed' || !p.exit) return null;
  const how = p.exit.code !== null ? `exit ${p.exit.code}` : p.exit.signal ? `killed by ${p.exit.signal}` : 'could not start';
  return p.exit.lastLine ? `${how} · ${p.exit.lastLine}` : how;
}

/** Which env file the row's process gets: none, or one of the package's env files. */
function EnvFileSelect({ projectId, info, envFiles }: { projectId: string; info: ScriptInfo; envFiles: string[] }) {
  const setEnvFile = useSetEnvFile(projectId);
  const missing = info.envFile !== null && !envFiles.includes(info.envFile) ? info.envFile : null;
  return (
    <label className="flex items-center gap-1" title="The env file this process gets (read at every start)">
      <span>Env</span>
      <select
        aria-label={`Env file for ${info.name}`}
        value={info.envFile ?? ''}
        disabled={setEnvFile.isPending}
        onChange={(e) => setEnvFile.mutate({ script: info.name, file: e.target.value === '' ? null : e.target.value })}
        className="h-5 max-w-32 rounded border border-line bg-app px-1 font-mono text-[11px] text-fg"
      >
        <option value="">none</option>
        {missing && <option value={missing}>{missing} (missing)</option>}
        {envFiles.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </label>
  );
}

function ScriptRow({
  projectId,
  info,
  process,
  envFiles,
  onEdit,
  onDelete,
  onHide,
}: {
  projectId: string;
  info: ScriptInfo;
  process: ProcessSummary | undefined;
  envFiles: string[];
  onEdit(): void;
  onDelete(): void;
  onHide(): void;
}) {
  const action = useScriptAction(projectId);
  const setAutoRestart = useSetAutoRestart(projectId);
  const setMain = useSetMain(projectId);
  const showScript = useUiStore((s) => s.showScript);
  const live = process !== undefined && isLive(process.state);
  const badge = process ? BADGES[process.state] : undefined;
  const crash = process ? crashText(process) : null;
  const busy = action.isPending && action.variables?.script === info.name;
  const chip = KIND_CHIPS[info.kind];

  return (
    <li className="rounded-md border border-line bg-card px-3 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => showScript(projectId, info.name)}
          className="min-w-0 truncate font-mono text-xs font-semibold text-fg hover:text-brand"
          title="Show output"
        >
          {info.name}
        </button>
        {chip && (
          <span title={chip.title} className="rounded border border-line px-1.5 py-px text-[10px] text-fg-muted">
            {chip.label}
          </span>
        )}
        {process && badge && (
          <span className={cn('rounded border px-1.5 py-px text-[10px] font-medium', badge)}>
            {process.state === 'exited' ? `exited ${process.exit?.code ?? ''}`.trim() : process.state}
          </span>
        )}
        {process?.warning && (
          <span
            title={process.warning}
            aria-label={`Version warning: ${process.warning}`}
            className="rounded border border-warn/40 px-1.5 py-px text-[10px] font-medium text-warn"
          >
            Node
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-pressed={info.main}
            aria-label={info.main ? `${info.name} is the main command` : `Make ${info.name} the main command`}
            title={info.main ? 'The main command of this package (click to clear)' : 'Make it the main command of this package'}
            disabled={setMain.isPending}
            onClick={() => setMain.mutate({ script: info.name, main: !info.main })}
          >
            <Star className={cn(info.main ? 'fill-current text-brand' : 'text-fg-faint')} />
          </Button>
          {info.kind === 'detected' && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${info.name}`}
              title="Remove this detected command (you can restore it below)"
              disabled={live}
              onClick={onHide}
            >
              <Trash2 />
            </Button>
          )}
          {info.kind === 'custom' && (
            <>
              <Button variant="ghost" size="icon" aria-label={`Edit ${info.name}`} onClick={onEdit}>
                <Pencil />
              </Button>
              <Button variant="ghost" size="icon" aria-label={`Delete ${info.name}`} disabled={live} onClick={onDelete}>
                <Trash2 />
              </Button>
            </>
          )}
          {live ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Stop ${info.name}`}
                disabled={busy || process.state === 'stopping'}
                onClick={() => action.mutate({ action: 'stop', script: info.name })}
              >
                <Square className="text-err" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Restart ${info.name}`}
                disabled={busy || process.state === 'stopping'}
                onClick={() => action.mutate({ action: 'restart', script: info.name })}
              >
                <RotateCw />
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Start ${info.name}`}
              disabled={busy}
              onClick={() => {
                showScript(projectId, info.name);
                action.mutate({ action: 'start', script: info.name });
              }}
            >
              <Play className="text-ok" />
            </Button>
          )}
        </div>
      </div>
      <p className="mt-0.5 truncate font-mono text-[11px] text-fg-muted" title={info.command}>
        {info.command}
      </p>
      {crash && <p className="mt-1 truncate font-mono text-[11px] text-err" title={crash}>{crash}</p>}
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-fg-muted">
        <Switch
          aria-label={`Auto-restart ${info.name}`}
          checked={info.autoRestart}
          disabled={setAutoRestart.isPending}
          onCheckedChange={(enabled) => setAutoRestart.mutate({ script: info.name, enabled })}
          className="scale-75"
        />
        <span>Auto-restart</span>
        <EnvFileSelect projectId={projectId} info={info} envFiles={envFiles} />
        {process && process.crashCount > 0 && (
          <span className="text-err">
            {process.crashCount} {process.crashCount === 1 ? 'crash' : 'crashes'}
          </span>
        )}
        {process?.nextRestartAt != null && <span className="text-warn">restarting…</span>}
        {process?.gaveUp && <span className="text-err">gave up after {process.crashCount} crashes</span>}
      </div>
    </li>
  );
}

export function ScriptList({ projectId }: { projectId: string }) {
  const { data, isPending, isError } = useScriptList(projectId);
  const { data: processes = [] } = useProcesses();
  const commands = useCommandActions(projectId);
  const [editing, setEditing] = useState<ScriptInfo | 'new' | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  if (isPending) return <p className="text-xs text-fg-muted">Loading scripts…</p>;
  if (isError || !data) return <p className="text-xs text-err">Couldn't load the scripts.</p>;
  return (
    <section aria-label="Scripts">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-semibold tracking-wider text-fg-muted uppercase">Scripts</h3>
        <Button variant="ghost" size="sm" onClick={() => setEditing('new')}>
          <Plus />
          Add command
        </Button>
      </div>
      {data.python && <PythonEnvPicker projectId={projectId} python={data.python} />}
      {data.scripts.length === 0 && <p className="text-xs text-fg-faint">No scripts or commands yet.</p>}
      <ul className="space-y-1.5">
        {data.scripts.map((info) => (
          <ScriptRow
            key={info.name}
            projectId={projectId}
            info={info}
            process={processes.find((p) => p.projectId === projectId && p.script === info.name)}
            envFiles={data.envFiles}
            onEdit={() => setEditing(info)}
            onDelete={() => setDeleting(info.name)}
            onHide={() => commands.hide.mutate(info.name)}
          />
        ))}
      </ul>
      {data.hidden.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-muted">
          <span>Removed:</span>
          {data.hidden.map((h) => (
            <span key={h.name} className="inline-flex items-center gap-1" title={h.command}>
              <span className="font-mono">{h.name}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[11px]"
                aria-label={`Restore ${h.name}`}
                disabled={commands.show.isPending}
                onClick={() => commands.show.mutate(h.name)}
              >
                Restore
              </Button>
            </span>
          ))}
        </p>
      )}
      {editing !== null && (
        <CommandDialog
          projectId={projectId}
          initial={editing === 'new' ? null : { name: editing.name, command: editing.command, main: editing.main }}
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete command “{deleting}”?</AlertDialogTitle>
            <AlertDialogDescription>Run groups that include it will skip it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-err text-fg hover:bg-err/90"
              onClick={() => deleting !== null && commands.remove.mutate(deleting)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
