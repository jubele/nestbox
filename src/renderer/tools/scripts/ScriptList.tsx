import { ChevronDown, ChevronRight, Pencil, Play, Plus, RotateCw, Square, Star, Trash2 } from 'lucide-react';
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
import type { Favorite, ScriptInfo, ScriptKind } from '@shared/tools/scripts/contract';
import { CommandDialog } from './CommandDialog';
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

/**
 * One runnable. `projectId` is the package it belongs to (every action goes there) and `tabId` the Scripts tab
 * showing it: a root's favorites belong to its packages, and are edited or removed in the package's own tab.
 */
function ScriptRow({
  projectId,
  tabId,
  packageName,
  info,
  process,
  envFiles,
  onEdit,
  onDelete,
}: {
  projectId: string;
  tabId: string;
  packageName?: string;
  info: ScriptInfo;
  process: ProcessSummary | undefined;
  envFiles: string[];
  onEdit?(): void;
  onDelete?(): void;
}) {
  const action = useScriptAction(projectId);
  const setAutoRestart = useSetAutoRestart(projectId);
  const setMain = useSetMain(projectId);
  const showScript = useUiStore((s) => s.showScript);
  const show = () => showScript(tabId, info.name, projectId);
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
          onClick={show}
          className="min-w-0 truncate font-mono text-xs font-semibold text-fg hover:text-brand"
          title="Show output"
        >
          {info.name}
        </button>
        {packageName !== undefined && (
          <span title="The package it belongs to" className="truncate text-[11px] text-fg-muted">
            {packageName}
          </span>
        )}
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
            title={
              info.main
                ? "The package's main command, listed in the project's Scripts tab (click to clear)"
                : "Make it the package's main command (listed in the project's Scripts tab)"
            }
            disabled={setMain.isPending}
            onClick={() => setMain.mutate({ script: info.name, main: !info.main })}
          >
            <Star className={cn(info.main ? 'fill-current text-brand' : 'text-fg-faint')} />
          </Button>
          {info.kind === 'custom' && onEdit && onDelete && (
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
                show();
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

type ListData = NonNullable<ReturnType<typeof useScriptList>['data']>;

export function ScriptList({ projectId }: { projectId: string }) {
  const { data, isPending, isError } = useScriptList(projectId);
  if (isPending) return <p className="text-xs text-fg-muted">Loading scripts…</p>;
  if (isError || !data) return <p className="text-xs text-err">Couldn't load the scripts.</p>;
  if (data.favorites === null) {
    return (
      <section aria-label="Scripts">
        <PackageScripts projectId={projectId} data={data} title="Scripts" />
      </section>
    );
  }
  return (
    <section aria-label="Scripts">
      <Favorites tabId={projectId} favorites={data.favorites} />
      <RootFolder projectId={projectId} data={data} />
    </section>
  );
}

/** A root's packages' main commands (its own included), each acting on its own package. */
function Favorites({ tabId, favorites }: { tabId: string; favorites: Favorite[] }) {
  const { data: processes = [] } = useProcesses();
  return (
    <div role="group" aria-label="Favorites">
      <h3 className="mb-2 text-[10px] font-semibold tracking-wider text-fg-muted uppercase">Favorites</h3>
      {favorites.length === 0 && (
        <p className="text-xs text-fg-faint">Star a script in a package's Scripts tab to show it here.</p>
      )}
      <ul className="space-y-1.5">
        {favorites.map((f) => (
          <ScriptRow
            key={f.projectId}
            projectId={f.projectId}
            tabId={tabId}
            packageName={f.packageName}
            info={f}
            process={processes.find((p) => p.projectId === f.projectId && p.script === f.name)}
            envFiles={f.envFiles}
          />
        ))}
      </ul>
    </div>
  );
}

/** The root folder's own scripts, folded away: its main one is already among the favorites. */
function RootFolder({ projectId, data }: { projectId: string; data: ListData }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[10px] font-semibold tracking-wider text-fg-muted uppercase hover:text-fg"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        Root folder ({data.scripts.length})
      </button>
      {open && (
        <div className="mt-2">
          <PackageScripts projectId={projectId} data={data} title={null} />
        </div>
      )}
    </div>
  );
}

/** One package's runnables, with Add command, the Python environment and restore. */
function PackageScripts({ projectId, data, title }: { projectId: string; data: ListData; title: string | null }) {
  const { data: processes = [] } = useProcesses();
  const commands = useCommandActions(projectId);
  const [editing, setEditing] = useState<ScriptInfo | 'new' | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  return (
    <>
      <div className={cn('mb-2 flex items-center gap-2', title === null ? 'justify-end' : 'justify-between')}>
        {title !== null && <h3 className="text-[10px] font-semibold tracking-wider text-fg-muted uppercase">{title}</h3>}
        <Button variant="ghost" size="sm" onClick={() => setEditing('new')}>
          <Plus />
          Add command
        </Button>
      </div>
      {data.scripts.length === 0 && <p className="text-xs text-fg-faint">No scripts or commands yet.</p>}
      <ul className="space-y-1.5">
        {data.scripts.map((info) => (
          <ScriptRow
            key={info.name}
            projectId={projectId}
            tabId={projectId}
            info={info}
            process={processes.find((p) => p.projectId === projectId && p.script === info.name)}
            envFiles={data.envFiles}
            onEdit={() => setEditing(info)}
            onDelete={() => setDeleting(info.name)}
          />
        ))}
      </ul>
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
    </>
  );
}
