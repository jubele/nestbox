import { Fragment, type ReactNode } from 'react';
import type { ToolPanelProps } from '../types';
import { useEcosystemSummaries, useProjectFacts } from './use-facts';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-fg">{title}</h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-xs text-fg-faint">{children}</p>;
}

export default function ProjectInfoPanel({ projectId }: ToolPanelProps) {
  const { data, isPending } = useProjectFacts(projectId);
  const { data: summaries } = useEcosystemSummaries(projectId);
  const ecosystems = summaries?.ecosystems ?? [];
  if (isPending || !data) return null;
  const scripts = Object.entries(data.packageJson?.scripts ?? {});
  const yesNo = (v: boolean) => (v ? 'yes' : 'no');

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Scripts">
        {scripts.length === 0 ? (
          <Empty>No scripts in package.json.</Empty>
        ) : (
          <ul className="space-y-1.5 font-mono text-xs">
            {scripts.map(([name, command]) => (
              <li key={name} className="flex gap-3">
                <span className="w-28 shrink-0 truncate text-fg">{name}</span>
                <span className="truncate text-fg-muted">{command}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Env files">
        {data.envFiles.length === 0 ? (
          <Empty>No .env files.</Empty>
        ) : (
          <ul className="space-y-1 font-mono text-xs text-fg">
            {data.envFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Stack">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-fg-muted">Package manager</dt>
          <dd className="font-mono text-fg">{data.packageManager ?? 'none'}</dd>
          {ecosystems.map((e) => (
            <Fragment key={e.id}>
              <dt className="text-fg-muted">Ecosystem</dt>
              <dd className="text-fg">{e.summary}</dd>
            </Fragment>
          ))}
          <dt className="text-fg-muted">Prisma schema</dt>
          <dd className="font-mono text-fg">{data.prismaSchema ?? 'none'}</dd>
          <dt className="text-fg-muted">Docker Compose</dt>
          <dd className="font-mono text-fg">{data.dockerCompose ?? 'none'}</dd>
          <dt className="text-fg-muted">Build output</dt>
          <dd className="font-mono text-fg">{data.buildOutput ?? 'none'}</dd>
          <dt className="text-fg-muted">Git</dt>
          <dd className="font-mono text-fg">
            {data.git ? (data.git.branch ?? data.git.head ?? 'unknown') : 'not a repository'}
          </dd>
        </dl>
      </Section>
      <Section title="Claude Code">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <dt className="font-mono text-fg-muted">CLAUDE.md</dt>
          <dd className="text-fg">{yesNo(data.claude.claudeMd)}</dd>
          <dt className="font-mono text-fg-muted">CLAUDE.local.md</dt>
          <dd className="text-fg">{yesNo(data.claude.claudeLocalMd)}</dd>
          <dt className="font-mono text-fg-muted">.claude/</dt>
          <dd className="text-fg">{yesNo(data.claude.claudeDir)}</dd>
          <dt className="font-mono text-fg-muted">.mcp.json</dt>
          <dd className="text-fg">{yesNo(data.claude.mcpJson)}</dd>
        </dl>
      </Section>
      {data.workspaces.length > 0 && (
        <Section title="Workspaces">
          <ul className="space-y-1.5 text-xs">
            {data.workspaces.map((w) => (
              <li key={w.id} className="flex gap-3">
                <span className="text-fg">{w.name}</span>
                <span className="font-mono text-fg-muted">{w.relPath}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
