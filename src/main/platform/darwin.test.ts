import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner, ExecResult } from './adapter';
import { createDarwinAdapter, type DarwinExtras } from './darwin';
import type { ShellEnv } from './posix-shell';

type Exec = (file: string, args: readonly string[]) => ExecResult | Error;

function setup(
  opts: { exec?: Exec; terminal?: string; editor?: string; installed?: string[]; extras?: DarwinExtras; pathPrepend?: string } = {},
) {
  const exec = vi.fn(async (file: string, args: readonly string[], _o?: { env?: NodeJS.ProcessEnv }) => {
    const result = opts.exec?.(file, args) ?? { code: 0, stdout: '' };
    if (result instanceof Error) throw result;
    return result;
  });
  const runner = { exec, launch: vi.fn(async () => undefined), spawn: vi.fn(() => ({}) as never) } as unknown as CommandRunner & {
    exec: typeof exec;
    launch: ReturnType<typeof vi.fn>;
    spawn: ReturnType<typeof vi.fn>;
  };
  const shellEnv: ShellEnv = { get: async () => ({ PATH: '/opt/homebrew/bin:/usr/bin', SHELL_ONLY: '1' }), clear: () => undefined };
  const written: { path: string; text: string }[] = [];
  const adapter = createDarwinAdapter(
    {
      runner,
      getEditorCommand: () => opts.editor ?? 'code',
      getTerminalApp: () => opts.terminal ?? 'auto',
      ...(opts.pathPrepend ? { pathPrepend: opts.pathPrepend } : {}),
    },
    {
      shellEnv,
      exists: async (path) => (opts.installed ?? []).some((app) => path.endsWith(`${app}.app`)),
      writeScript: async (path, text) => void written.push({ path, text }),
      now: () => 1_000_000,
      ...opts.extras,
    },
  );
  return { adapter, runner, written };
}

const lsof = readFileSync(join(__dirname, '__fixtures__', 'lsof-listen.txt'), 'utf8');

describe('darwin adapter: ports and processes', () => {
  it('lists listening ports through lsof, grouped by port and PID, with names', async () => {
    const { adapter, runner } = setup({ exec: (file) => (file === '/usr/sbin/lsof' ? { code: 0, stdout: lsof } : { code: 1, stdout: '' }) });
    const ports = await adapter.listListeningPorts();
    expect(ports.find((p) => p.port === 3000)).toEqual({ port: 3000, pid: 20140, addresses: ['0.0.0.0', '::'], processName: 'node' });
    expect(ports.map((p) => p.port)).toEqual([631, 3000, 5173, 5432, 8080]);
    expect(runner.exec.mock.calls[0]?.[1]).toEqual(['-nP', '-iTCP', '-sTCP:LISTEN', '+c', '0', '-F', 'pcftn']);
  });

  it('reads "nothing listens" from lsof exit 1 with no output, and fails on other errors', async () => {
    expect(await setup({ exec: () => ({ code: 1, stdout: '' }) }).adapter.listListeningPorts()).toEqual([]);
    await expect(setup({ exec: () => ({ code: 2, stdout: '' }) }).adapter.listListeningPorts()).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('lists processes with start times from elapsed time, in the C locale', async () => {
    const { adapter, runner } = setup({ exec: () => ({ code: 0, stdout: '  412     1   412      10:00\n' }) });
    expect(await adapter.listProcesses()).toEqual([{ pid: 412, parentPid: 1, groupId: 412, startTime: 1_000_000 - 600_000 }]);
    expect(runner.exec.mock.calls[0]?.[1]).toEqual(['-axo', 'pid=,ppid=,pgid=,etime=']);
    expect(runner.exec.mock.calls[0]?.[0]).toBe('/bin/ps');
    expect(runner.exec.mock.calls[0]?.[2]?.env?.['LC_ALL']).toBe('C');
  });

  it('describes processes, keeping unknown PIDs as null and rejecting bad ones', async () => {
    const { adapter, runner } = setup({ exec: () => ({ code: 1, stdout: '412 /opt/homebrew/bin/postgres -D x\n' }) });
    expect(await adapter.describeProcesses([412, 999])).toEqual(
      new Map([
        [412, '/opt/homebrew/bin/postgres -D x'],
        [999, null],
      ]),
    );
    expect(runner.exec.mock.calls[0]?.[1]).toEqual(['-ww', '-o', 'pid=,command=', '-p', '412,999']);
    // launchd can own a port: describing it is fine (only killing PID 1 is refused).
    await expect(adapter.describeProcesses([1])).resolves.toBeInstanceOf(Map);
    await expect(adapter.describeProcesses([-1])).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('kills a tree through the process group', async () => {
    const signals: string[] = [];
    const kill = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      if (signal !== 0) {
        signals.push(`${signal} ${pid}`);
        return;
      }
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const { adapter } = setup({ exec: () => ({ code: 0, stdout: '' }), extras: { kill, sleep: async () => undefined } });
    await adapter.killTree(500);
    expect(signals).toEqual(['SIGTERM -500']);
    await expect(adapter.killTree(0)).rejects.toMatchObject({ code: 'VALIDATION' });
    // launchd: killTree(1) would be kill(-1), every process of the user.
    await expect(adapter.killTree(1)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(signals).toEqual(['SIGTERM -500']);
  });
});

describe('darwin adapter: running things', () => {
  it('spawns scripts directly, as the leader of a new process group', () => {
    const { adapter, runner } = setup();
    adapter.spawnScript({ cwd: '/Users/me/shop', command: 'pnpm', args: ['run', 'dev'], env: { PATH: '/x' } });
    expect(runner.spawn).toHaveBeenCalledWith('pnpm', ['run', 'dev'], { cwd: '/Users/me/shop', env: { PATH: '/x' }, newProcessGroup: true });
  });

  it('passes stdin to spawnCommand', () => {
    const { adapter, runner } = setup();
    adapter.spawnCommand({ cwd: '/a', command: 'claude', args: ['-p'], env: {}, stdin: 'hi "there"' });
    expect(runner.spawn).toHaveBeenCalledWith('claude', ['-p'], { cwd: '/a', env: {}, newProcessGroup: true, stdin: 'hi "there"' });
  });

  it('runs execCommand with the login-shell env and the command found on its PATH', async () => {
    const { adapter, runner } = setup();
    await adapter.execCommand('git', ['check-ignore', '-q', 'x'], { cwd: '/a', timeoutMs: 5_000 });
    const [file, args, opts] = runner.exec.mock.calls[0] ?? [];
    // git isn't really under /opt/homebrew/bin in the test: the bare name is kept.
    expect(typeof file).toBe('string');
    expect(args).toEqual(['check-ignore', '-q', 'x']);
    expect(opts).toMatchObject({ cwd: '/a', timeoutMs: 5_000, env: { SHELL_ONLY: '1' } });
  });

  it('puts a development PATH prefix (end-to-end fakes) ahead of the login shell\'s PATH', async () => {
    const { adapter } = setup({ pathPrepend: '/e2e/fake-npm' });
    expect((await adapter.resolveShellEnv())['PATH']).toBe('/e2e/fake-npm:/opt/homebrew/bin:/usr/bin');
  });

  it('adds extra env variables on top of the login-shell env', async () => {
    const { adapter, runner } = setup();
    await adapter.execCommand('pnpm', ['--version'], { cwd: '/a', timeoutMs: 5_000, env: { COREPACK_ENABLE_NETWORK: '0' } });
    expect(runner.exec.mock.calls[0]?.[2]).toMatchObject({ env: { SHELL_ONLY: '1', COREPACK_ENABLE_NETWORK: '0' } });
  });

  it('passes an output cap to the runner', async () => {
    const { adapter, runner } = setup();
    await adapter.execCommand('git', ['status'], { cwd: '/a', timeoutMs: 5_000, maxBytes: 2_000_000 });
    expect(runner.exec.mock.calls[0]?.[2]).toMatchObject({ maxBytes: 2_000_000 });
  });

  it('uses the login shell env for scripts and an inset title bar', async () => {
    const { adapter } = setup();
    expect(await adapter.resolveShellEnv()).toMatchObject({ SHELL_ONLY: '1' });
    expect(adapter.windowChrome({ color: 'a', symbolColor: 'b', height: 40 })).toEqual({ titleBarStyle: 'hiddenInset' });
    expect(adapter.notificationAppId()).toBeNull();
  });

  it('runs python3 and finds a virtualenv\'s bin folder', () => {
    const { adapter } = setup();
    expect(adapter.pythonCommand).toBe('python3');
    expect(adapter.venvBinDir('/Users/me/shop/backend/.venv')).toBe('/Users/me/shop/backend/.venv/bin');
  });

  it('compares paths case-insensitively', () => {
    const { adapter } = setup();
    expect(adapter.samePath('/Users/me/Shop/', '/users/me/shop')).toBe(true);
  });
});

describe('darwin adapter: editor', () => {
  it('opens VS Code through its app when the code command is not on PATH', async () => {
    const { adapter, runner } = setup({ exec: () => ({ code: 0, stdout: '' }) });
    // A vscode:// URL reaches a VS Code that is already running too (open -b --args would only focus it).
    await adapter.openInEditor('/Users/me/my shop/#1/a.ts', 12);
    expect(runner.exec).toHaveBeenCalledWith('/usr/bin/open', ['vscode://file/Users/me/my%20shop/%231/a.ts:12'], expect.anything());
    await adapter.openInEditor('/Users/me/shop');
    expect(runner.exec).toHaveBeenLastCalledWith('/usr/bin/open', ['vscode://file/Users/me/shop'], expect.anything());
  });

  it('says NOT_FOUND for another missing editor, and for VS Code that is not installed', async () => {
    await expect(setup({ editor: 'cursor' }).adapter.openInEditor('/a')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setup({ exec: () => ({ code: 1, stdout: '' }) }).adapter.openInEditor('/a')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a bad line number', async () => {
    await expect(setup().adapter.openInEditor('/a', 0)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('darwin adapter: terminals', () => {
  it('opens a folder in iTerm2 when installed, Terminal otherwise', async () => {
    const withIterm = setup({ installed: ['iTerm'] });
    await withIterm.adapter.openTerminal('/Users/me/shop');
    expect(withIterm.runner.exec).toHaveBeenCalledWith('/usr/bin/open', ['-a', 'iTerm', '/Users/me/shop'], expect.anything());
    const plain = setup();
    await plain.adapter.openTerminal('/Users/me/shop');
    expect(plain.runner.exec).toHaveBeenCalledWith('/usr/bin/open', ['-a', 'Terminal', '/Users/me/shop'], expect.anything());
  });

  it('runs a command through a self-deleting .command file', async () => {
    const { adapter, runner, written } = setup({ terminal: 'terminal' });
    await adapter.openTerminal("/Users/me/it's", 'claude --continue');
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toMatch(/nestbox-[0-9a-f-]+\.command$/);
    expect(written[0]?.text).toContain("cd '/Users/me/it'\\''s' || exit 1\nclaude --continue\n");
    expect(runner.exec).toHaveBeenCalledWith('/usr/bin/open', ['-a', 'Terminal', written[0]?.path], expect.anything());
  });

  it('passes the command to Ghostty as arguments', async () => {
    const { adapter, runner, written } = setup({ terminal: 'ghostty' });
    await adapter.openTerminal('/x', 'claude');
    expect(written).toEqual([]);
    const args = runner.exec.mock.calls[0]?.[1] ?? [];
    expect(args.slice(0, 5)).toEqual(['-na', 'Ghostty', '--args', '--working-directory=/x', '-e']);
    expect(args.slice(6)).toEqual(['-lic', expect.stringMatching(/^claude; exec '\/.+' -l$/)]);
  });

  it('refuses commands that are not plain words, and reports a terminal that would not open', async () => {
    await expect(setup().adapter.openTerminal('/x', 'claude; rm -rf ~')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(setup({ exec: () => ({ code: 1, stdout: '' }) }).adapter.openTerminal('/x')).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('darwin adapter: commandExists', () => {
  it('walks the login-shell PATH without a subprocess', async () => {
    const { adapter, runner } = setup();
    expect(await adapter.commandExists('definitely-not-installed-nestbox')).toBe(false);
    expect(runner.exec).not.toHaveBeenCalled();
  });
});
