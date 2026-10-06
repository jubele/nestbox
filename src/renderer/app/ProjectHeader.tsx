import { ExternalLink, Folder, GitBranch, MoreHorizontal, Square, SquareTerminal } from 'lucide-react';
import { belongsTo, isLive } from '@shared/processes';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  useProcesses,
  useStopAll,
  useOpenInEditor,
  useOpenTerminal,
  useRefreshProject,
  useRenameProject,
  useSetPinned,
} from '@/lib/queries';
import { useGitStatus } from '@/tools/git/use-git';
import type { ProjectNode } from './find-project';
import { RemoveProjectDialog } from './RemoveProjectDialog';
import { RenameInput } from './RenameInput';

export function ProjectHeader({ node }: { node: ProjectNode }) {
  const { detected, summary, isWorkspace } = node;
  const [renaming, setRenaming] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const keepFocus = useRef(false);
  const openInEditor = useOpenInEditor();
  const openTerminal = useOpenTerminal();
  const refresh = useRefreshProject();
  const rename = useRenameProject();
  const setPinned = useSetPinned();
  const stopAll = useStopAll();
  const { data: processes = [] } = useProcesses();
  const live = (projectId: string) => processes.filter((p) => isLive(p.state) && belongsTo(p.projectId, projectId)).length;
  const liveHere = live(detected.id);
  // The git tool's live status (shared with its card), so a checkout shows here without a project refresh.
  const { data: git } = useGitStatus(detected.id, detected.git !== null);
  const liveRef = git?.state === 'ok' ? (git.branch ?? git.detachedAt) : null;
  const ref = liveRef ?? detected.git?.branch ?? detected.git?.head ?? null;

  return (
    <div className="border-b border-line bg-card/40 px-5 pt-5 pb-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-3">
            {renaming ? (
              <RenameInput
                initial={summary.name}
                onSubmit={(name) => {
                  rename.mutate({ id: summary.id, name });
                  setRenaming(false);
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              <h1
                className="truncate text-xl font-bold tracking-tight text-fg"
                aria-label={isWorkspace ? `${summary.name} / ${detected.name}` : undefined}
              >
                {isWorkspace ? (
                  <>
                    <span className="text-fg-muted">{summary.name}</span>
                    <span aria-hidden className="mx-2 text-fg-faint">
                      ·
                    </span>
                    <span>{detected.name}</span>
                  </>
                ) : (
                  detected.name
                )}
              </h1>
            )}
            {detected.missing && (
              <Badge variant="outline" className="border-err/30 bg-err/10 text-err">
                missing
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-fg-muted">
            <span className="flex min-w-0 items-center gap-1">
              <Folder aria-hidden className="size-3.5 shrink-0 text-fg-faint" />
              <span className="truncate">{detected.path}</span>
            </span>
            {detected.packageManager && (
              <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-fg">
                {detected.packageManager}
              </span>
            )}
            {ref && (
              <span className="flex items-center gap-1 text-brand">
                <GitBranch aria-hidden className="size-3.5" />
                {ref}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {liveHere > 0 && (
            <Button
              variant="secondary"
              size="sm"
              disabled={stopAll.isPending}
              onClick={() => stopAll.mutate(detected.id)}
            >
              <Square className="text-err" />
              Stop all
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={detected.missing || openInEditor.isPending}
            onClick={() => openInEditor.mutate(detected.id)}
          >
            <ExternalLink className="text-brand" />
            Open in VS Code
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={detected.missing || openTerminal.isPending}
            onClick={() => openTerminal.mutate(detected.id)}
          >
            <SquareTerminal className="text-brand" />
            Open terminal here
          </Button>
          {/* modal={false}: opening the AlertDialog from a menu item must not leave pointer-events locked. */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Project actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(e) => {
                if (keepFocus.current) {
                  e.preventDefault();
                  keepFocus.current = false;
                }
              }}
            >
              <DropdownMenuItem onSelect={() => refresh.mutate(detected.id)}>Refresh</DropdownMenuItem>
              {!isWorkspace && (
                <>
                  <DropdownMenuItem onSelect={() => setPinned.mutate({ id: summary.id, pinned: !summary.pinned })}>
                    {summary.pinned ? 'Unpin' : 'Pin'}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      keepFocus.current = true;
                      setRenaming(true);
                    }}
                  >
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      keepFocus.current = true;
                      setConfirmRemove(true);
                    }}
                  >
                    Remove
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <RemoveProjectDialog project={summary} open={confirmRemove} onOpenChange={setConfirmRemove} />
    </div>
  );
}
