import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DetectedProject } from '@shared/detected';
import { NestboxError } from '@shared/errors';
import { makeDetectedForTest } from '@shared/test-fixtures';
import type { RunGroup } from '@shared/types';
import { makeTree, removeTree } from '../../detection/test-fixtures';
import { createMemoryLogger } from '../../logger';
import { createDarwinAdapter } from '../../platform/darwin';
import type { SpawnOpts } from '../../platform/adapter';
import { noopRunner } from '../../platform/testing';
import { fakePlatform, flushIo } from '../../processes/fake-child';
import { ProcessManager } from '../../processes/process-manager';
import { createSharedContext } from '../shared-context';
import { createToolHost } from '../tool-host';
import { createScriptsTool, PROCESSES_FACT } from './index';

const ROOT = resolve('/dev/shop');
const API = resolve(ROOT, 'packages/api');

const api = makeDetectedForTest({
  id: 'r1::packages/api',
  rootId: 'r1',
  relPath: 'packages/api',
  name: '@shop/api',
  path: API,
  packageJson: { name: '@shop/api', scripts: { dev: 'nest start --watch' } },
});
const root = makeDetectedForTest({
  id: 'r1',
  rootId: 'r1',
  path: ROOT,
  packageJson: { name: 'shop', scripts: { dev: 'vite', build: 'vite build' } },
  workspaces: [api],
});

function setup(projects: DetectedProject[] = [root, api]) {
  const platform = fakePlatform();
  const processes = new ProcessManager({
    platform,
    ledger: { add: vi.fn(), remove: vi.fn() },
    bufferLines: () => 1_000,
    logger: createMemoryLogger(),
  });
  let groups: RunGroup[] = [];
  const toolSettings = new Map<string, unknown>();
  const shared = createSharedContext();
  const deps = {
    processes,
    runGroups: { get: vi.fn(() => groups), set: vi.fn((_root: string, next: RunGroup[]) => (groups = next)) },
    getDetected: (id: string): DetectedProject => {
      const found = projects.find((p) => p.id === id);
      if (!found) throw new NestboxError('NOT_FOUND', 'Project not found');
      return found;
    },
    shared,
    saveFile: vi.fn(async (_name: string): Promise<string | null> => 'C:\\out\\dev.log'),
    writeFile: vi.fn(async (_path: string, _text: string) => {}),
    isFile: vi.fn(async (_path: string) => true),
    emit: vi.fn(),
    logger: createMemoryLogger(),
    platform: createDarwinAdapter({ runner: noopRunner, getEditorCommand: () => 'code' }),
    node: {
      advice: vi.fn(
        async (_projectId: string): Promise<{ warning: string | null; pathPrepend: string | null; note: string | null }> => ({
          warning: null,
          pathPrepend: null,
          note: null,
        }),
      ),
    },
    compose: {
      up: vi.fn(async (_projectId: string, _services: string[], _opts: { wait: boolean }) => ({ ok: true })),
      stop: vi.fn(async (_projectId: string, _services: string[]) => ({ ok: true })),
    },
    envFiles: {
      list: vi.fn(async (_dir: string): Promise<string[]> => ['.env', '.env.local']),
      read: vi.fn(async (_dir: string, file: string): Promise<Record<string, string> | null> =>
        file === '.env' ? { API_KEY: 'from-dotenv' } : null,
      ),
    },
  };
  const adapter = createDarwinAdapter({ runner: noopRunner, getEditorCommand: () => 'code' });
  const openInEditor = vi.fn(async () => {});
  const host = createToolHost({
    tools: [createScriptsTool(deps)],
    getProject: deps.getDetected,
    shared,
    platform: { ...adapter, openInEditor },
    emit: vi.fn(),
    logger: createMemoryLogger(),
    toolSettings: {
      get: (rootId, toolId) => toolSettings.get(`${rootId}/${toolId}`),
      set: (rootId, toolId, value) => void toolSettings.set(`${rootId}/${toolId}`, value),
    },
  });
  const call = (projectId: string, method: string, input: unknown = {}) => host.invoke('scripts', projectId, method, input);
  return { platform, processes, deps, call, toolSettings, openInEditor, setGroups: (g: RunGroup[]) => (groups = g) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('scripts tool: list and lifecycle', () => {
  it('lists scripts, run groups and packages on a root', async () => {
    const { call, setGroups } = setup();
    setGroups([{ name: 'dev', entries: [{ relPath: '', script: 'dev' }], compose: [] }]);
    expect(await call('r1', 'list')).toEqual({
      scripts: [
        { name: 'dev', command: 'vite', autoRestart: false, kind: 'npm', envFile: null, main: false },
        { name: 'build', command: 'vite build', autoRestart: false, kind: 'npm', envFile: null, main: false },
      ],
      runGroups: [{ name: 'dev', entries: [{ relPath: '', script: 'dev' }], compose: [] }],
      packages: [
        { relPath: '', name: 'shop', scripts: ['dev', 'build'], compose: false, main: null },
        { relPath: 'packages/api', name: '@shop/api', scripts: ['dev'], compose: false, main: null },
      ],
      envFiles: ['.env', '.env.local'],
      hidden: [],
      python: null,
    });
  });

  it('lists no run groups or packages on a workspace', async () => {
    const { call } = setup();
    expect(await call(api.id, 'list')).toMatchObject({ runGroups: null, packages: null });
  });

  it('starts in the package folder with the package manager', async () => {
    const { call, platform } = setup();
    expect(await call(api.id, 'start', { script: 'dev' })).toMatchObject({ projectId: api.id, script: 'dev', state: 'starting' });
    expect(platform.spawnScript).toHaveBeenCalledWith(expect.objectContaining({ cwd: API, command: 'pnpm', args: ['run', 'dev'] }));
  });

  it('rejects an unknown script without naming it', async () => {
    const { call } = setup();
    await expect(call('r1', 'start', { script: 'secret-name' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Unknown script',
    });
  });

  it('stops and restarts', async () => {
    const { call, platform } = setup();
    await call('r1', 'start', { script: 'dev' });
    expect(await call('r1', 'stop', { script: 'dev' })).toMatchObject({ state: 'stopped' });
    expect(await call('r1', 'restart', { script: 'dev' })).toMatchObject({ state: 'starting' });
    expect(platform.spawnScript).toHaveBeenCalledTimes(2);
  });

  it('stores auto-restart on the root and applies it to a live process', async () => {
    const { call, toolSettings, processes } = setup();
    await call(api.id, 'start', { script: 'dev' });
    expect(await call(api.id, 'setAutoRestart', { script: 'dev', enabled: true })).toEqual({ enabled: true });
    expect(toolSettings.get('r1/scripts')).toEqual({ autoRestart: [{ relPath: 'packages/api', script: 'dev' }], commands: [], envFiles: [], main: [], hidden: {}, venvs: [] });
    expect(processes.get(api.id, 'dev')?.autoRestart).toBe(true);
    expect(await call(api.id, 'list')).toMatchObject({ scripts: [{ name: 'dev', autoRestart: true }] });
    await call(api.id, 'setAutoRestart', { script: 'dev', enabled: false });
    expect(toolSettings.get('r1/scripts')).toEqual({ autoRestart: [], commands: [], envFiles: [], main: [], hidden: {}, venvs: [] });
  });

  it('starts with auto-restart from settings', async () => {
    const { call, toolSettings } = setup();
    toolSettings.set('r1/scripts', { autoRestart: [{ relPath: '', script: 'dev' }] });
    expect(await call('r1', 'start', { script: 'dev' })).toMatchObject({ autoRestart: true });
  });
});

describe('scripts tool: logs', () => {
  it('returns logs after a seq', async () => {
    const { call, platform } = setup();
    await call('r1', 'start', { script: 'dev' });
    platform.last().stdout.write('a\nb\n');
    await flushIo();
    expect(await call('r1', 'getLogs', { script: 'dev', afterSeq: 2 })).toMatchObject({
      lines: [{ seq: 3, text: 'b' }],
      lastSeq: 3,
    });
  });

  it('streams batched log events per project and script', async () => {
    const { call, platform, deps } = setup();
    await call(api.id, 'start', { script: 'dev' });
    platform.last().stdout.write('one\ntwo\n');
    await flushIo();
    expect(deps.emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(deps.emit).toHaveBeenCalledTimes(1);
    expect(deps.emit).toHaveBeenCalledWith(api.id, 'logs', {
      script: 'dev',
      lines: [
        expect.objectContaining({ text: '▸ pnpm run dev' }),
        expect.objectContaining({ text: 'one' }),
        expect.objectContaining({ text: 'two' }),
      ],
    });
  });

  it('publishes process facts to the shared context', async () => {
    const { call, deps } = setup();
    await call('r1', 'start', { script: 'dev' });
    expect(deps.shared.forProject('r1').get(PROCESSES_FACT)).toEqual([{ script: 'dev', pid: 1000, state: 'starting' }]);
  });

  it('empties the published facts of a project whose processes were forgotten', async () => {
    const { call, deps, processes } = setup();
    await call('r1', 'start', { script: 'dev' });
    await processes.stopAll((id) => id === 'r1');
    processes.forget((id) => id === 'r1');
    expect(deps.shared.forProject('r1').get(PROCESSES_FACT)).toEqual([]);
  });

  it('clears logs', async () => {
    const { call } = setup();
    await call('r1', 'start', { script: 'dev' });
    await call('r1', 'clearLogs', { script: 'dev' });
    expect(await call('r1', 'getLogs', { script: 'dev' })).toMatchObject({ lines: [] });
  });

  it('exports selected lines, everything, or nothing when cancelled', async () => {
    const { call, platform, deps } = setup();
    await call('r1', 'start', { script: 'dev' });
    platform.last().stdout.write('a\nb\n');
    await flushIo();
    expect(await call('r1', 'exportLogs', { script: 'dev', seqs: [2, 3] })).toEqual({ saved: true });
    const written = vi.mocked(deps.writeFile).mock.calls[0]?.[1] ?? '';
    expect(written.split('\r\n').filter(Boolean).map((l) => l.slice(25))).toEqual(['a', 'b']);
    await call('r1', 'exportLogs', { script: 'dev', seqs: 'all' });
    expect(vi.mocked(deps.writeFile).mock.calls[1]?.[1].split('\r\n').filter(Boolean)).toHaveLength(3);
    deps.saveFile.mockResolvedValueOnce(null);
    expect(await call('r1', 'exportLogs', { script: 'dev', seqs: 'all' })).toEqual({ saved: false });
    expect(deps.writeFile).toHaveBeenCalledTimes(2);
  });
});

describe('scripts tool: openFileAt', () => {
  it.each([
    ['a relative path', 'src/a.ts', resolve(ROOT, 'src/a.ts')],
    ['a Vite-style rooted path', '/src/App.tsx', resolve(ROOT, 'src/App.tsx')],
    ['an absolute path', resolve('/elsewhere/x.ts'), resolve('/elsewhere/x.ts')],
    ['a file URL', pathToFileURL(resolve('/elsewhere/y.js')).href, resolve('/elsewhere/y.js')],
  ])('opens %s at the line', async (_label, path, expected) => {
    const { call, openInEditor, deps } = setup();
    deps.isFile.mockImplementation(async (p: string) => p === expected);
    await call('r1', 'openFileAt', { path, line: 12 });
    expect(openInEditor).toHaveBeenCalledWith(expected, 12);
  });

  it('falls back to a rooted path as absolute when the project has no such file', async () => {
    const { call, openInEditor, deps } = setup();
    const absolute = resolve('/var/log/app.ts');
    deps.isFile.mockImplementation(async (p: string) => p === absolute);
    await call('r1', 'openFileAt', { path: '/var/log/app.ts', line: 3 });
    expect(openInEditor).toHaveBeenCalledWith(absolute, 3);
  });

  it('refuses a missing file', async () => {
    const { call, openInEditor, deps } = setup();
    deps.isFile.mockResolvedValue(false);
    await expect(call('r1', 'openFileAt', { path: 'nope.ts', line: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'File not found',
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });
});

describe('scripts tool: Node advice', () => {
  it('starts with the Node tool\'s warning, note and PATH', async () => {
    const { call, deps, processes, platform } = setup();
    deps.node.advice.mockResolvedValue({
      warning: "Node v20.11.1 doesn't match 18 (.nvmrc)",
      pathPrepend: '/fnm/18/bin',
      note: '▸ fnm: Node 18 from /fnm/18/bin',
    });
    expect(await call(api.id, 'start', { script: 'dev' })).toMatchObject({ warning: "Node v20.11.1 doesn't match 18 (.nvmrc)" });
    expect(deps.node.advice).toHaveBeenCalledWith(api.id);
    expect(processes.logs(api.id, 'dev').lines.map((l) => l.text).slice(0, 2)).toEqual([
      '▸ fnm: Node 18 from /fnm/18/bin',
      "▲ Node v20.11.1 doesn't match 18 (.nvmrc)",
    ]);
    const env = (platform.spawnScript.mock.calls as unknown as [{ env: NodeJS.ProcessEnv }][])[0]?.[0].env;
    expect(env?.['PATH']).toMatch(/^\/fnm\/18\/bin/);
  });

  it('starts without advice when the Node tool fails or takes over 3 s', async () => {
    const { call, deps } = setup();
    deps.node.advice.mockRejectedValueOnce(new NestboxError('INTERNAL', 'boom'));
    expect(await call('r1', 'start', { script: 'dev' })).toMatchObject({ state: 'starting', warning: null });
    deps.node.advice.mockReturnValueOnce(new Promise(() => undefined));
    const slow = call('r1', 'start', { script: 'build' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await slow).toMatchObject({ state: 'starting', warning: null });
  });
});

describe('scripts tool: run groups', () => {
  const group = (name: string, entries: [string, string][]): RunGroup => ({
    name,
    entries: entries.map(([relPath, script]) => ({ relPath, script })),
    compose: [],
  });

  it('saves, renames and deletes groups on the root only', async () => {
    const { call } = setup();
    expect(await call('r1', 'saveRunGroup', { group: group('dev', [['', 'dev']]) })).toEqual([group('dev', [['', 'dev']])]);
    await expect(call('r1', 'saveRunGroup', { group: group('dev', [['', 'build']]), previousName: undefined })).resolves.toEqual([
      group('dev', [['', 'build']]),
    ]);
    await call('r1', 'saveRunGroup', { group: group('other', []) });
    await expect(call('r1', 'saveRunGroup', { previousName: 'other', group: group('dev', []) })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await call('r1', 'saveRunGroup', { previousName: 'other', group: group('all', []) })).toEqual([
      group('dev', [['', 'build']]),
      group('all', []),
    ]);
    expect(await call('r1', 'deleteRunGroup', { name: 'dev' })).toEqual([group('all', [])]);
    await expect(call(api.id, 'saveRunGroup', { group: group('x', []) })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(call('r1', 'deleteRunGroup', { name: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('starts what it can and reports missing and running entries', async () => {
    const { call, setGroups, platform } = setup();
    setGroups([
      group('dev', [
        ['', 'dev'],
        ['packages/api', 'dev'],
        ['packages/gone', 'dev'],
        ['', 'nope'],
        ['', 'build'],
      ]),
    ]);
    await call('r1', 'start', { script: 'build' });
    const result = (await call('r1', 'startRunGroup', { name: 'dev' })) as {
      started: { projectId: string }[];
      skipped: unknown[];
    };
    expect(result.started.map((s) => s.projectId).sort()).toEqual(['r1', api.id]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { relPath: 'packages/gone', script: 'dev', reason: 'missing' },
        { relPath: '', script: 'nope', reason: 'missing' },
        { relPath: '', script: 'build', reason: 'running' },
      ]),
    );
    expect(platform.spawnScript).toHaveBeenCalledWith(expect.objectContaining({ cwd: API }));
  });

  it('stopping a group also cancels a member waiting to auto-restart', async () => {
    const { call, setGroups, processes, platform, toolSettings } = setup();
    toolSettings.set('r1/scripts', { autoRestart: [{ relPath: 'packages/api', script: 'dev' }] });
    setGroups([group('dev', [['packages/api', 'dev']])]);
    await call('r1', 'startRunGroup', { name: 'dev' });
    platform.last().exit(1);
    await flushIo();
    expect(processes.get(api.id, 'dev')?.nextRestartAt).not.toBeNull();
    await call('r1', 'stopRunGroup', { name: 'dev' });
    expect(processes.get(api.id, 'dev')).toMatchObject({ state: 'stopped', nextRestartAt: null });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(platform.spawnScript).toHaveBeenCalledTimes(1);
  });

  const withCompose = (g: RunGroup, compose: [string, string[]][]): RunGroup => ({
    ...g,
    compose: compose.map(([relPath, services]) => ({ relPath, services })),
  });
  const composeRoot = makeDetectedForTest({ ...root, dockerCompose: 'compose.yaml', workspaces: [api] });

  it('brings compose services up (and waits) before the scripts start', async () => {
    const { call, setGroups, deps, platform } = setup();
    deps.getDetected = (id: string) => (id === 'r1' ? composeRoot : api);
    const order: string[] = [];
    let release = () => {};
    deps.compose.up.mockImplementation(async (projectId: string) => {
      order.push(`compose ${projectId}`);
      await new Promise<void>((r) => (release = r));
      return { ok: true };
    });
    platform.spawnScript.mockImplementation(((...args: Parameters<typeof platform.spawnScript>) => {
      order.push('script');
      return fakePlatform().spawnScript(...args);
    }) as typeof platform.spawnScript);
    setGroups([withCompose(group('dev', [['packages/api', 'dev']]), [['', ['db', 'redis']]])]);
    const started = call('r1', 'startRunGroup', { name: 'dev' });
    await vi.waitFor(() => expect(order).toEqual(['compose r1']));
    release();
    expect(await started).toMatchObject({ compose: [{ relPath: '', result: 'ok' }] });
    expect(order).toEqual(['compose r1', 'script']);
    expect(deps.compose.up).toHaveBeenCalledWith('r1', ['db', 'redis'], { wait: true });
  });

  it('starts the scripts even when a compose step fails, and says why', async () => {
    const { call, setGroups, deps } = setup();
    const composeApi = makeDetectedForTest({ ...api, dockerCompose: 'docker-compose.yml' });
    deps.getDetected = (id: string) => {
      if (id === 'r1') return composeRoot;
      if (id === api.id) return composeApi;
      throw new NestboxError('NOT_FOUND', 'Project not found');
    };
    deps.compose.up.mockImplementation(async (projectId: string) => {
      if (projectId === 'r1') throw new NestboxError('CONFLICT', 'Another Compose action is running');
      return { ok: false };
    });
    setGroups([
      withCompose(group('dev', [['packages/api', 'dev']]), [
        ['', []],
        ['packages/api', ['db']],
        ['packages/gone', []],
      ]),
    ]);
    const result = (await call('r1', 'startRunGroup', { name: 'dev' })) as { started: unknown[]; compose: unknown[] };
    expect(result.started).toHaveLength(1);
    expect(result.compose).toEqual([
      { relPath: '', result: 'busy' },
      { relPath: 'packages/api', result: 'failed' },
      { relPath: 'packages/gone', result: 'missing' },
    ]);
  });

  it('calls a step missing when its services left the file or the package lost its compose file', async () => {
    const { call, setGroups, deps } = setup();
    deps.getDetected = (id: string) => (id === 'r1' ? composeRoot : api);
    deps.compose.up.mockRejectedValue(new NestboxError('NOT_FOUND', 'None of these services are in the compose file'));
    setGroups([withCompose(group('db', []), [['', ['old']], ['packages/api', []]])]);
    expect(await call('r1', 'startRunGroup', { name: 'db' })).toEqual({
      started: [],
      skipped: [],
      compose: [
        { relPath: '', result: 'missing' },
        { relPath: 'packages/api', result: 'missing' },
      ],
    });
  });

  it('stopping a group stops its compose services, never down', async () => {
    const { call, setGroups, deps } = setup();
    deps.getDetected = (id: string) => (id === 'r1' ? composeRoot : api);
    setGroups([withCompose(group('db', []), [['', ['db']]])]);
    await call('r1', 'stopRunGroup', { name: 'db' });
    expect(deps.compose.stop).toHaveBeenCalledWith('r1', ['db']);
    expect(deps.compose.up).not.toHaveBeenCalled();
  });

  it('stops only the group\'s live entries', async () => {
    const { call, setGroups, processes } = setup();
    setGroups([group('dev', [['packages/api', 'dev']])]);
    await call('r1', 'start', { script: 'dev' });
    await call('r1', 'startRunGroup', { name: 'dev' });
    await call('r1', 'stopRunGroup', { name: 'dev' });
    expect(processes.get(api.id, 'dev')?.state).toBe('stopped');
    expect(processes.get('r1', 'dev')?.state).toBe('starting');
  });
});

const APP = resolve('/dev/app');
const BACKEND = resolve(APP, 'backend');
/** A package without package.json scripts: it runs only what the user adds. */
const backend = makeDetectedForTest({
  id: 'r2::backend',
  rootId: 'r2',
  relPath: 'backend',
  name: 'backend',
  path: BACKEND,
  packageJson: { name: 'backend', scripts: {} },
});
const frontend = makeDetectedForTest({
  id: 'r2::frontend',
  rootId: 'r2',
  relPath: 'frontend',
  name: 'web',
  path: resolve(APP, 'frontend'),
  packageJson: { name: 'web', scripts: { dev: 'vite' } },
});
const app = makeDetectedForTest({
  id: 'r2',
  rootId: 'r2',
  path: APP,
  name: 'app',
  packageJson: null,
  packageManager: null,
  workspaces: [backend, frontend],
});

/** What each spawn got (the fake's mock is typed without parameters). */
const spawnCalls = (platform: ReturnType<typeof fakePlatform>): SpawnOpts[] =>
  (platform.spawnScript.mock.calls as unknown as [SpawnOpts][]).map(([opts]) => opts);

/** The frontend + backend project, the backend with a custom `dev` command. */
async function appSetup() {
  const ctx = setup([app, backend, frontend]);
  await ctx.call(backend.id, 'saveCommand', { name: 'dev', argv: ['node', 'server.js', '--port', '8000'] });
  return ctx;
}

describe('scripts tool: custom commands', () => {
  it('lists custom commands after package scripts', async () => {
    const { call } = await appSetup();
    await call(frontend.id, 'saveCommand', { name: 'storybook', argv: ['npx', 'storybook', 'dev'] });
    expect(await call(frontend.id, 'list')).toEqual({
      scripts: [
        { name: 'dev', command: 'vite', autoRestart: false, kind: 'npm', envFile: null, main: false },
        { name: 'storybook', command: 'npx storybook dev', autoRestart: false, kind: 'custom', envFile: '.env', main: false },
      ],
      runGroups: null,
      packages: null,
      envFiles: ['.env', '.env.local'],
      hidden: [],
      python: null,
    });
    expect(await call('r2', 'list')).toMatchObject({
      scripts: [],
      packages: [
        { relPath: '', name: 'app', scripts: [] },
        { relPath: 'backend', name: 'backend', scripts: ['dev'] },
        { relPath: 'frontend', name: 'web', scripts: ['dev', 'storybook'] },
      ],
    });
  });

  it('runs a custom command as typed, without a shell or the Node tool', async () => {
    const { call, platform, deps } = await appSetup();
    await call(backend.id, 'start', { script: 'dev' });
    expect(spawnCalls(platform)[0]).toMatchObject({ cwd: BACKEND, command: 'node', args: ['server.js', '--port', '8000'] });
    expect(deps.node.advice).not.toHaveBeenCalled();
  });

  it('keeps names unique within a package', async () => {
    const { call } = await appSetup();
    await expect(call(frontend.id, 'saveCommand', { name: 'dev', argv: ['x'] })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(call(backend.id, 'saveCommand', { name: 'dev', argv: ['x'] })).rejects.toMatchObject({ code: 'CONFLICT' });
    await call(backend.id, 'saveCommand', { name: 'a', argv: ['x'] });
    await call(backend.id, 'saveCommand', { name: 'b', argv: ['x'] });
    await expect(call(backend.id, 'saveCommand', { previousName: 'a', name: 'b', argv: ['x'] })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(call(backend.id, 'saveCommand', { previousName: 'gone', name: 'c', argv: ['x'] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // The same name in another package is fine.
    await call(frontend.id, 'saveCommand', { name: 'a', argv: ['y'] });
  });

  it('refuses commands that could not run safely', async () => {
    const { call } = await appSetup();
    for (const argv of [[], ['PORT=1', 'x'], ['echo', 'a"b'], ['a\nb']]) {
      await expect(call(backend.id, 'saveCommand', { name: 'x', argv })).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    await expect(call(backend.id, 'saveCommand', { name: 'bad name', argv: ['x'] })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('carries auto-restart and run groups over a rename, and forgets them on delete', async () => {
    const { call, setGroups, toolSettings } = await appSetup();
    await call(backend.id, 'saveCommand', { name: 'worker', argv: ['node', 'worker.js'] });
    await call(backend.id, 'setAutoRestart', { script: 'worker', enabled: true });
    setGroups([{ name: 'all', entries: [{ relPath: 'backend', script: 'worker' }], compose: [] }]);
    await call(backend.id, 'saveCommand', { previousName: 'worker', name: 'jobs', argv: ['node', 'worker.js', '-v'] });
    expect(await call('r2', 'list')).toMatchObject({
      runGroups: [{ name: 'all', entries: [{ relPath: 'backend', script: 'jobs' }] }],
    });
    expect(toolSettings.get('r2/scripts')).toMatchObject({ autoRestart: [{ relPath: 'backend', script: 'jobs' }] });
    await call(backend.id, 'deleteCommand', { name: 'jobs' });
    expect(toolSettings.get('r2/scripts')).toMatchObject({ autoRestart: [] });
  });

  it('will not rename or delete a running command', async () => {
    const { call } = await appSetup();
    await call(backend.id, 'saveCommand', { name: 'worker', argv: ['node', 'worker.js'] });
    await call(backend.id, 'start', { script: 'worker' });
    await expect(call(backend.id, 'deleteCommand', { name: 'worker' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      call(backend.id, 'saveCommand', { previousName: 'worker', name: 'w', argv: ['node', 'worker.js'] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Editing the command line keeps the name: allowed, and used from the next start.
    await call(backend.id, 'saveCommand', { previousName: 'worker', name: 'worker', argv: ['node', 'w2.js'] });
    await expect(call(frontend.id, 'deleteCommand', { name: 'dev' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('starts a package.json script and a custom command from one run group', async () => {
    const { call, platform, setGroups } = await appSetup();
    setGroups([
      {
        name: 'dev',
        entries: [
          { relPath: 'backend', script: 'dev' },
          { relPath: 'frontend', script: 'dev' },
        ],
        compose: [],
      },
    ]);
    const result = (await call('r2', 'startRunGroup', { name: 'dev' })) as { started: unknown[]; skipped: unknown[] };
    expect(result.started).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    const commands = spawnCalls(platform).map((o) => [o.cwd, o.command, ...o.args]);
    expect(commands).toEqual(
      expect.arrayContaining([
        [BACKEND, 'node', 'server.js', '--port', '8000'],
        [resolve(APP, 'frontend'), 'pnpm', 'run', 'dev'],
      ]),
    );
  });
});

describe('scripts tool: env files for commands', () => {
  it('gives custom commands .env by default, package.json scripts none', async () => {
    const { call, platform } = await appSetup();
    await call(backend.id, 'start', { script: 'dev' });
    await call(frontend.id, 'start', { script: 'dev' });
    const [cmd, web] = spawnCalls(platform);
    expect(cmd?.env['API_KEY']).toBe('from-dotenv');
    expect(web?.env['API_KEY']).toBeUndefined();
  });

  it('switches a command to another file or none, and a script to .env', async () => {
    const { call, platform, deps, toolSettings } = await appSetup();
    await call(backend.id, 'setEnvFile', { script: 'dev', file: '.env.local' });
    await call(frontend.id, 'setEnvFile', { script: 'dev', file: '.env' });
    expect(await call(backend.id, 'list')).toMatchObject({ scripts: [{ name: 'dev', envFile: '.env.local' }] });
    await call(backend.id, 'start', { script: 'dev' });
    await call(frontend.id, 'start', { script: 'dev' });
    expect(deps.envFiles.read).toHaveBeenCalledWith(BACKEND, '.env.local');
    expect(spawnCalls(platform)[1]?.env['API_KEY']).toBe('from-dotenv');
    await call(backend.id, 'setEnvFile', { script: 'dev', file: null });
    expect(await call(backend.id, 'list')).toMatchObject({ scripts: [{ name: 'dev', envFile: null }] });
    // Back to the default: no override is kept.
    await call(backend.id, 'setEnvFile', { script: 'dev', file: '.env' });
    expect(toolSettings.get('r2/scripts')).toMatchObject({ envFiles: [{ relPath: 'frontend', script: 'dev', file: '.env' }] });
    await expect(call(backend.id, 'setEnvFile', { script: 'nope', file: null })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(backend.id, 'setEnvFile', { script: 'dev', file: '../x' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('carries the env file over a rename and forgets it on delete', async () => {
    const { call, toolSettings } = await appSetup();
    await call(backend.id, 'saveCommand', { name: 'worker', argv: ['node', 'worker.js'] });
    await call(backend.id, 'setEnvFile', { script: 'worker', file: null });
    await call(backend.id, 'saveCommand', { previousName: 'worker', name: 'jobs', argv: ['node', 'worker.js'] });
    expect(toolSettings.get('r2/scripts')).toMatchObject({ envFiles: [{ relPath: 'backend', script: 'jobs', file: null }] });
    await call(backend.id, 'deleteCommand', { name: 'jobs' });
    expect(toolSettings.get('r2/scripts')).toMatchObject({ envFiles: [] });
  });
});

describe('scripts tool: main command', () => {
  it('marks one main per package, listed first and named in packages', async () => {
    const { call } = await appSetup();
    await call(backend.id, 'saveCommand', { name: 'api', argv: ['node', 'api.js'], main: true });
    expect(await call(backend.id, 'list')).toMatchObject({
      scripts: [
        { name: 'api', main: true },
        { name: 'dev', main: false },
      ],
    });
    await call(backend.id, 'setMain', { script: 'dev', main: true });
    expect(await call('r2', 'list')).toMatchObject({
      packages: [
        { relPath: '', main: null },
        { relPath: 'backend', main: 'dev' },
        { relPath: 'frontend', main: null },
      ],
    });
    await call(backend.id, 'setMain', { script: 'dev', main: false });
    expect(await call(backend.id, 'list')).toMatchObject({ scripts: [{ name: 'dev', main: false }, { name: 'api', main: false }] });
    await expect(call(backend.id, 'setMain', { script: 'nope', main: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('carries main over a rename, clears it with main: false and forgets it on delete', async () => {
    const { call, toolSettings } = await appSetup();
    await call(backend.id, 'saveCommand', { name: 'api', argv: ['node', 'api.js'], main: true });
    await call(backend.id, 'saveCommand', { previousName: 'api', name: 'server', argv: ['node', 'api.js'] });
    expect(toolSettings.get('r2/scripts')).toMatchObject({ main: [{ relPath: 'backend', script: 'server' }] });
    await call(backend.id, 'saveCommand', { previousName: 'server', name: 'server', argv: ['node', 'api.js'], main: false });
    expect(toolSettings.get('r2/scripts')).toMatchObject({ main: [] });
    await call(backend.id, 'setMain', { script: 'server', main: true });
    await call(backend.id, 'deleteCommand', { name: 'server' });
    expect(toolSettings.get('r2/scripts')).toMatchObject({ main: [] });
  });
});

describe('scripts tool: ecosystems (Python)', () => {
  let tree = '';
  afterEach(async () => removeTree(tree));

  /** frontend/ (npm) + backend/ (Python, its own .venv) on disk, so runEnv can find pyvenv.cfg. */
  async function pythonSetup(files: Record<string, string> = {}) {
    tree = await makeTree({ 'backend/.venv/pyvenv.cfg': '', 'backend/main.py': '', 'backend/tools/seed.py': '', ...files });
    const info = { venv: '.venv', framework: null, entries: ['main.py'], tests: true };
    const backend = makeDetectedForTest({
      id: 'p3::backend',
      rootId: 'p3',
      relPath: 'backend',
      name: 'backend',
      path: join(tree, 'backend'),
      packageJson: null,
      packageManager: null,
      ecosystems: [{ id: 'python', info }],
    });
    const root = makeDetectedForTest({ id: 'p3', rootId: 'p3', path: tree, name: 'app', packageJson: null, workspaces: [backend] });
    return { ...setup([root, backend]), backend };
  }

  it('lists the tasks as detected rows, and hides and restores them', async () => {
    const { call, backend } = await pythonSetup();
    expect(await call(backend.id, 'list')).toMatchObject({
      scripts: [
        { name: 'main', command: 'python main.py', kind: 'detected' },
        { name: 'pytest', command: 'python -m pytest', kind: 'detected' },
      ],
      hidden: [],
      python: { choice: 'auto', venv: 'backend/.venv', auto: 'backend/.venv' },
    });
    await call(backend.id, 'hideCommand', { name: 'pytest' });
    expect(await call(backend.id, 'list')).toMatchObject({
      scripts: [{ name: 'main' }],
      hidden: [{ name: 'pytest', command: 'python -m pytest' }],
    });
    await call(backend.id, 'showCommand', { name: 'pytest' });
    expect(await call(backend.id, 'list')).toMatchObject({ hidden: [], scripts: [{ name: 'main' }, { name: 'pytest' }] });
  });

  it('runs detected and custom commands in the virtualenv', async () => {
    const { call, platform, processes, backend } = await pythonSetup();
    await call(backend.id, 'saveCommand', { name: 'seed', argv: ['python', 'tools/seed.py'] });
    await call(backend.id, 'start', { script: 'main' });
    await call(backend.id, 'start', { script: 'seed' });
    const venv = join(tree, 'backend', '.venv');
    for (const spawned of spawnCalls(platform)) {
      expect(spawned).toMatchObject({ command: 'python', env: { VIRTUAL_ENV: venv, PYTHONUNBUFFERED: '1' } });
      expect(spawned.env['PATH']?.split(delimiter)[0]).toBe(join(venv, 'bin'));
    }
    expect(processes.logs(backend.id, 'seed').lines.map((l) => l.text)).toContain('▸ virtualenv: backend/.venv');
  });

  it('uses the platform\'s python without a virtualenv, or when system Python is chosen', async () => {
    const { call, platform, toolSettings, backend } = await pythonSetup();
    await call(backend.id, 'setVenv', { mode: 'none' });
    expect(toolSettings.get('p3/scripts')).toMatchObject({ venvs: [{ relPath: 'backend', venv: null }] });
    expect(await call(backend.id, 'list')).toMatchObject({ python: { choice: 'none', venv: null } });
    await call(backend.id, 'start', { script: 'main' });
    expect(spawnCalls(platform)[0]).toMatchObject({ command: 'python3', args: ['main.py'] });
    expect(spawnCalls(platform)[0]?.env['VIRTUAL_ENV']).toBeUndefined();
  });

  it('picks a virtualenv by path (it must hold pyvenv.cfg) and lists the project\'s', async () => {
    const { call, platform, deps, backend } = await pythonSetup({ 'shared/env/pyvenv.cfg': '' });
    expect(await call(backend.id, 'pythonEnvs')).toEqual({ envs: ['backend/.venv', 'shared/env'] });
    deps.isFile.mockResolvedValueOnce(false);
    await expect(call(backend.id, 'setVenv', { mode: 'path', path: 'nope' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await call(backend.id, 'setVenv', { mode: 'path', path: 'shared/env' });
    await call(backend.id, 'start', { script: 'main' });
    expect(spawnCalls(platform)[0]?.env['VIRTUAL_ENV']).toBe(join(tree, 'shared', 'env'));
    await call(backend.id, 'setVenv', { mode: 'auto' });
    expect(await call(backend.id, 'list')).toMatchObject({ python: { choice: 'auto' } });
  });

  it('offers the files a module can run, and no environment choice outside Python', async () => {
    const { call, backend } = await pythonSetup();
    expect(await call(backend.id, 'files')).toEqual({
      files: [
        { path: 'main.py', argv: ['python', 'main.py'] },
        { path: 'tools/seed.py', argv: ['python', 'tools/seed.py'] },
      ],
    });
    expect(await call('p3', 'files')).toEqual({ files: [] });
    expect(await call('p3', 'list')).toMatchObject({ python: null, hidden: [] });
    await expect(call('p3', 'setVenv', { mode: 'none' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
