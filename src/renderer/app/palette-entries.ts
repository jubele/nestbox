// The command palette's entries, built from data the renderer already has. Pure: actions are data, run by
// CommandPalette, so what the palette offers can be tested without rendering it.
import { type DetectedProject, type ProjectSummary, workspaceId } from '@shared/detected';
import type { ProcessSummary } from '@shared/processes';
import type { ToolSummary } from '@shared/tool';
import type { RunGroup } from '@shared/types';
import type { ProjectNode } from './find-project';

export const PALETTE_GROUPS = ['Projects', 'Tools', 'Scripts', 'Run groups', 'Claude', 'Go to'] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

export type PaletteAction =
  | { kind: 'select'; projectId: string }
  | { kind: 'tab'; projectId: string; tab: string }
  | { kind: 'script'; projectId: string; script: string; op: 'start' | 'stop' }
  | { kind: 'group'; rootId: string; name: string; op: 'start' | 'stop' }
  | { kind: 'claude'; projectId: string; op: 'open' | 'continue' }
  | { kind: 'ports' }
  | { kind: 'settings' };

export interface PaletteEntry {
  /** Unique; also what cmdk matches on together with the label and keywords. */
  id: string;
  group: PaletteGroup;
  label: string;
  /** Shown faint after the label (a path, a command). */
  detail?: string;
  keywords: string[];
  action: PaletteAction;
  disabled?: boolean;
}

export interface PaletteInput {
  projects: readonly ProjectSummary[];
  selected: ProjectNode | null;
  processes: readonly ProcessSummary[];
  /** The selected root project's run groups. */
  runGroups: readonly RunGroup[];
  /**
   * What each package of the selected root project can run, from the Scripts tool (package.json scripts,
   * detected commands the user hasn't removed, custom commands). Commands come only from here.
   */
  runnables?: readonly { relPath: string; scripts: readonly string[] }[];
  /** The selected project's tools. */
  tools: readonly ToolSummary[];
  /** Whether the Claude Code tool is on (its entries need it). */
  claudeOn?: boolean;
}

const LIVE = new Set<ProcessSummary['state']>(['starting', 'running']);

/** Every root project and workspace package, with the name of the root for workspaces. */
function packages(projects: readonly ProjectSummary[]): { detected: DetectedProject; title: string; root: ProjectSummary }[] {
  return projects.flatMap((root) => [
    { detected: root.detected, title: root.name, root },
    ...root.detected.workspaces.map((w) => ({ detected: w, title: `${root.name} › ${w.name}`, root })),
  ]);
}

export function paletteEntries({
  projects,
  selected,
  processes,
  runGroups,
  runnables = [],
  tools,
  claudeOn = true,
}: PaletteInput): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  const all = packages(projects);
  const stateOf = (projectId: string, script: string) => processes.find((p) => p.projectId === projectId && p.script === script)?.state;

  for (const { detected, title, root } of all) {
    out.push({
      id: `project:${detected.id}`,
      group: 'Projects',
      label: title,
      detail: detected.path,
      keywords: [root.name, ...root.tags, ...(detected.relPath === '' ? root.detected.workspaces.map((w) => w.name) : [detected.relPath])],
      action: { kind: 'select', projectId: detected.id },
    });
  }

  if (selected) {
    const id = selected.detected.id;
    for (const tool of [{ id: 'overview', name: 'Overview' }, ...tools]) {
      out.push({
        id: `tool:${id}:${tool.id}`,
        group: 'Tools',
        label: `Open ${tool.name}`,
        detail: selected.detected.name,
        keywords: [tool.id],
        action: { kind: 'tab', projectId: id, tab: tool.id },
      });
    }
  }

  for (const { detected, title } of all) {
    // package.json scripts everywhere; commands (detected, custom) in the selected root, where the list is known.
    const npm = Object.entries(detected.packageJson?.scripts ?? {});
    const listed =
      detected.rootId === selected?.summary.id ? runnables.find((r) => r.relPath === detected.relPath)?.scripts ?? [] : [];
    const commands = listed.filter((name) => !npm.some(([script]) => script === name)).map((name) => [name, 'command'] as const);
    for (const [script, command] of [...npm, ...commands]) {
      const state = stateOf(detected.id, script);
      const live = state !== undefined && LIVE.has(state);
      out.push({
        id: `script:${detected.id}:${script}`,
        group: 'Scripts',
        label: `${live ? 'Stop' : 'Run'} ${script} in ${title}`,
        detail: command,
        keywords: [script, detected.name],
        action: { kind: 'script', projectId: detected.id, script, op: live ? 'stop' : 'start' },
        disabled: state === 'stopping',
      });
    }
  }

  if (selected) {
    const rootId = selected.summary.id;
    for (const group of runGroups) {
      const live = group.entries.some((e) => {
        const state = stateOf(e.relPath === '' ? rootId : workspaceId(rootId, e.relPath), e.script);
        return state !== undefined && LIVE.has(state);
      });
      out.push({
        id: `group:${rootId}:${group.name}`,
        group: 'Run groups',
        label: `${live ? 'Stop' : 'Start'} run group ${group.name}`,
        detail: selected.summary.name,
        keywords: group.entries.map((e) => e.script),
        action: { kind: 'group', rootId, name: group.name, op: live ? 'stop' : 'start' },
      });
    }
  }

  for (const { detected, title } of claudeOn ? all : []) {
    out.push(
      {
        id: `claude:open:${detected.id}`,
        group: 'Claude',
        label: `Claude: open ${title}`,
        keywords: ['claude code', 'terminal'],
        action: { kind: 'claude', projectId: detected.id, op: 'open' },
      },
      {
        id: `claude:continue:${detected.id}`,
        group: 'Claude',
        label: `Claude: continue ${title}`,
        keywords: ['claude code', 'resume'],
        action: { kind: 'claude', projectId: detected.id, op: 'continue' },
      },
    );
  }

  out.push(
    { id: 'goto:ports', group: 'Go to', label: 'Ports', keywords: ['listening', 'kill'], action: { kind: 'ports' } },
    { id: 'goto:settings', group: 'Go to', label: 'Settings', keywords: ['preferences', 'options'], action: { kind: 'settings' } },
  );
  return out;
}
