import { Columns2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DEFAULT_PANES, useUiStore } from '@/state/ui-store';
import type { ToolPanelProps } from '../types';
import { LogPane, type PaneOption } from './LogPane';
import { RunGroups } from './RunGroups';
import { ScriptList } from './ScriptList';
import { useScriptList } from './use-scripts';

export default function ScriptsPanel({ projectId }: ToolPanelProps) {
  const panes = useUiStore((s) => s.scriptPanes[projectId] ?? DEFAULT_PANES);
  const setPaneScript = useUiStore((s) => s.setPaneScript);
  const setActivePane = useUiStore((s) => s.setActivePane);
  const toggleSplit = useUiStore((s) => s.toggleSplit);
  const { data } = useScriptList(projectId);
  // A root with packages also offers its packages' favorites, named with the package.
  const options: PaneOption[] = [
    ...(data?.favorites ?? [])
      .filter((f) => f.projectId !== projectId)
      .map((f) => ({
        ref: { projectId: f.projectId, script: f.name },
        label: `${f.packageName} · ${f.name}`,
      })),
    ...(data?.scripts ?? []).map((s) => ({ ref: { projectId, script: s.name }, label: s.name })),
  ];
  const split = panes.scripts.length > 1;

  return (
    <div className="grid h-full min-h-0 grid-cols-[320px_minmax(0,1fr)] gap-4">
      <div className="min-h-0 overflow-y-auto pr-1">
        <RunGroups projectId={projectId} />
        <ScriptList projectId={projectId} />
      </div>
      <div className="flex min-h-0 min-w-0 flex-col gap-2">
        <div className="flex justify-end">
          <Button variant={split ? 'secondary' : 'ghost'} size="sm" aria-pressed={split} onClick={() => toggleSplit(projectId)}>
            <Columns2 />
            Split
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 gap-3">
          {panes.scripts.map((script, i) => (
            <LogPane
              key={i} // panes are positional
              target={script}
              options={options}
              onTargetChange={(target) => setPaneScript(projectId, i, target)}
              active={split && panes.active === i}
              onActivate={() => setActivePane(projectId, i)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
