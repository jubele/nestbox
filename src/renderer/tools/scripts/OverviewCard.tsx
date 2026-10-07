import { Play } from 'lucide-react';
import { aggregateState, belongsTo, isLive } from '@shared/processes';
import { splitProjectId, workspaceId } from '@shared/detected';
import { StateDot } from '@/components/StateDot';
import { Button } from '@/components/ui/button';
import { useProcesses } from '@/lib/queries';
import { useUiStore } from '@/state/ui-store';
import type { ToolPanelProps } from '../types';
import { useScriptList, useStartIn } from './use-scripts';

export function ScriptsCard({ projectId }: ToolPanelProps) {
  const { data: processes = [] } = useProcesses();
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const { data } = useScriptList(projectId);
  const start = useStartIn();
  const shown = processes.filter((p) => belongsTo(p.projectId, projectId) && (isLive(p.state) || p.state === 'crashed'));
  const running = (id: string, script: string) =>
    processes.some((p) => p.projectId === id && p.script === script && isLive(p.state));
  // Main commands that aren't running: each package's on a root, the package's own elsewhere.
  const { rootId } = splitProjectId(projectId);
  const mains = (
    data?.packages
      ? data.packages.flatMap((p) =>
          p.main === null
            ? []
            : [{ id: p.relPath === '' ? rootId : workspaceId(rootId, p.relPath), script: p.main, label: p.name }],
        )
      : (data?.scripts ?? []).filter((s) => s.main).map((s) => ({ id: projectId, script: s.name, label: null }))
  ).filter((m) => !running(m.id, m.script));

  return (
    <section aria-label="Scripts" className="flex flex-col gap-3 rounded-lg border border-line bg-card p-4">
      <h3 className="text-[10px] font-semibold tracking-wider text-fg-muted uppercase">Scripts</h3>
      {shown.length === 0 ? (
        <p className="text-xs text-fg-faint">No scripts running.</p>
      ) : (
        <ul className="space-y-1.5 text-xs">
          {shown.map((p) => (
            <li key={`${p.projectId}/${p.script}`} className="flex items-center gap-2">
              <StateDot state={aggregateState([p.state])} />
              <span className="truncate font-mono text-fg">
                {p.projectId === projectId ? p.script : `${splitProjectId(p.projectId).relPath} · ${p.script}`}
              </span>
              <span className="ml-auto text-fg-muted">{p.state}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {mains.map((m) => (
          <Button
            key={`${m.id}/${m.script}`}
            variant="secondary"
            size="sm"
            aria-label={m.label === null ? `Start ${m.script}` : `Start ${m.script} in ${m.label}`}
            disabled={start.isPending}
            onClick={() => start.mutate({ projectId: m.id, script: m.script })}
          >
            <Play className="text-ok" />
            {m.label === null ? m.script : `${m.label} · ${m.script}`}
          </Button>
        ))}
        <Button variant="secondary" size="sm" onClick={() => setActiveTab(projectId, 'scripts')}>
          Open Scripts
        </Button>
      </div>
    </section>
  );
}
