import { Button } from '@/components/ui/button';
import type { ToolPanelProps } from '../types';
import { useEcosystemSummaries, useProjectFacts } from './use-facts';

export function ProjectInfoCard({ projectId }: ToolPanelProps) {
  const { data, isError, refetch, isFetching } = useProjectFacts(projectId);
  const { data: summaries } = useEcosystemSummaries(projectId);
  const ecosystems = summaries?.ecosystems ?? [];
  if (isError) {
    return (
      <section aria-label="Project info" className="flex flex-col gap-3 rounded-lg border border-line bg-card p-4">
        <h3 className="text-[10px] font-semibold tracking-wider text-fg-muted uppercase">Project</h3>
        <p className="text-xs text-err">Couldn't load project info.</p>
        <Button variant="secondary" size="sm" className="self-start" disabled={isFetching} onClick={() => void refetch()}>
          Retry
        </Button>
      </section>
    );
  }
  if (!data) {
    return (
      <section aria-label="Project info" aria-busy="true" className="flex flex-col gap-3 rounded-lg border border-line bg-card p-4">
        <h3 className="text-[10px] font-semibold tracking-wider text-fg-muted uppercase">Project</h3>
        <div className="space-y-2" data-testid="project-info-skeleton">
          <div className="h-3 w-3/4 rounded bg-surface" />
          <div className="h-3 w-1/2 rounded bg-surface" />
          <div className="h-3 w-2/3 rounded bg-surface" />
        </div>
      </section>
    );
  }
  const scripts = Object.keys(data.packageJson?.scripts ?? {}).length;
  const claudeFiles = Object.values(data.claude).filter(Boolean).length;
  return (
    <section
      aria-label="Project info"
      className="flex flex-col gap-3 rounded-lg border border-line bg-card p-4"
    >
      <h3 className="text-[10px] font-semibold tracking-wider text-fg-muted uppercase">Project</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-fg-muted">Package manager</dt>
        <dd className="font-mono text-fg">{data.packageManager ?? 'none'}</dd>
        {ecosystems.length > 0 && (
          <>
            <dt className="text-fg-muted">Ecosystems</dt>
            <dd className="text-fg">{ecosystems.map((e) => e.summary).join(', ')}</dd>
          </>
        )}
        <dt className="text-fg-muted">Scripts</dt>
        <dd className="text-fg">{scripts} scripts</dd>
        <dt className="text-fg-muted">Env files</dt>
        <dd className="text-fg">{data.envFiles.length}</dd>
        <dt className="text-fg-muted">Workspaces</dt>
        <dd className="text-fg">{data.workspaces.length}</dd>
        <dt className="text-fg-muted">Claude Code</dt>
        <dd className="text-fg">{claudeFiles} of 4 files</dd>
      </dl>
    </section>
  );
}
