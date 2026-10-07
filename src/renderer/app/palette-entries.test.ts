import { describe, expect, it } from 'vitest';
import { makeDetected, makeProcess, makeSummary } from '@/test/fixtures';
import { findProjectNode } from './find-project';
import { paletteEntries, type PaletteInput } from './palette-entries';

const api = makeDetected({ id: 'p1::packages/api', rootId: 'p1', relPath: 'packages/api', name: '@shop/api', packageJson: { scripts: { start: 'node .' } } });
const shop = makeSummary({ detected: makeDetected({ workspaces: [api] }) });
const blog = makeSummary({ id: 'p2', name: 'blog' });

function input(over: Partial<PaletteInput> = {}): PaletteInput {
  return {
    projects: [shop, blog],
    selected: findProjectNode([shop, blog], 'p1'),
    processes: [],
    runGroups: [{ name: 'all', entries: [{ relPath: '', script: 'dev' }, { relPath: 'packages/api', script: 'start' }], compose: [] }],
    tools: [{ id: 'scripts', name: 'Scripts', icon: 'play' }],
    ...over,
  };
}

const labels = (entries: ReturnType<typeof paletteEntries>, group: string) => entries.filter((e) => e.group === group).map((e) => e.label);

describe('paletteEntries', () => {
  it('lists projects and workspace packages, findable by workspace name', () => {
    const entries = paletteEntries(input());
    expect(labels(entries, 'Projects')).toEqual(['shop', 'shop › @shop/api', 'blog']);
    expect(entries.find((e) => e.id === 'project:p1')?.keywords).toContain('@shop/api');
    expect(entries.find((e) => e.id === 'project:p1::packages/api')?.action).toEqual({ kind: 'select', projectId: 'p1::packages/api' });
  });

  it("offers the selected project's tools, Overview first", () => {
    const entries = paletteEntries(input());
    expect(labels(entries, 'Tools')).toEqual(['Open Overview', 'Open Scripts']);
    expect(entries.find((e) => e.label === 'Open Scripts')?.action).toEqual({ kind: 'tab', projectId: 'p1', tab: 'scripts' });
    expect(labels(paletteEntries(input({ selected: null })), 'Tools')).toEqual([]);
  });

  it('runs stopped scripts and stops live ones', () => {
    const entries = paletteEntries(
      input({ processes: [makeProcess({ projectId: 'p1', script: 'dev', state: 'running' }), makeProcess({ projectId: 'p2', script: 'build', state: 'stopping' })] }),
    );
    expect(labels(entries, 'Scripts')).toEqual([
      'Stop dev in shop',
      'Run build in shop',
      'Run start in shop › @shop/api',
      'Run dev in blog',
      'Run build in blog',
    ]);
    expect(entries.find((e) => e.label === 'Stop dev in shop')?.action).toEqual({ kind: 'script', projectId: 'p1', script: 'dev', op: 'stop' });
    expect(entries.find((e) => e.label === 'Run build in blog')?.disabled).toBe(true);
    expect(entries.find((e) => e.label === 'Run dev in blog')?.detail).toBe('vite');
  });

  it("runs the selected project's commands from the Scripts tool's list, never removed ones", () => {
    const entries = paletteEntries(
      input({
        runnables: [
          { relPath: '', scripts: ['dev', 'build', 'seed'] },
          // 'runserver' was detected but removed: it isn't in the list.
          { relPath: 'packages/api', scripts: ['start', 'worker'] },
        ],
      }),
    );
    expect(entries.find((e) => e.label === 'Run seed in shop')?.action).toEqual({ kind: 'script', projectId: 'p1', script: 'seed', op: 'start' });
    expect(entries.find((e) => e.label === 'Run worker in shop › @shop/api')?.detail).toBe('command');
    // A package.json script keeps its own entry (and text), once.
    expect(entries.filter((e) => e.id === 'script:p1:dev').map((e) => e.detail)).toEqual(['vite']);
    // Other projects' commands aren't known: only their package.json scripts.
    expect(labels(entries, 'Scripts').filter((l) => l.endsWith('in blog'))).toEqual(['Run dev in blog', 'Run build in blog']);
  });

  it('starts run groups, and stops one with a live entry in a workspace package', () => {
    expect(labels(paletteEntries(input()), 'Run groups')).toEqual(['Start run group all']);
    const live = paletteEntries(input({ processes: [makeProcess({ projectId: 'p1::packages/api', script: 'start' })] }));
    expect(live.find((e) => e.group === 'Run groups')?.action).toEqual({ kind: 'group', rootId: 'p1', name: 'all', op: 'stop' });
  });

  it('opens or continues Claude in every package, and goes to Ports and Settings', () => {
    const entries = paletteEntries(input());
    expect(labels(entries, 'Claude')).toContain('Claude: continue shop › @shop/api');
    expect(labels(entries, 'Go to')).toEqual(['Ports', 'Settings']);
  });

  it('leaves Claude out when the Claude Code tool is off', () => {
    expect(labels(paletteEntries(input({ claudeOn: false })), 'Claude')).toEqual([]);
  });

  it('gives every entry a unique id', () => {
    const ids = paletteEntries(input()).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
