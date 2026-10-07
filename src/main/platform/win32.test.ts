import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NestboxError } from '@shared/errors';
import type { CommandRunner } from './adapter';
import { type ExecCall, type ExecScript, noopRunner, scriptedExec } from './testing';
import { createWin32Adapter } from './win32';
import { cmdInvocation } from './win32-escape';

interface Call {
  file: string;
  args: readonly string[];
  opts: { cwd?: string; verbatim?: boolean; hidden?: boolean } | undefined;
}

function fakeRunner(failFiles: string[] = [], script: ExecScript = {}): CommandRunner & { calls: Call[]; execCalls: ExecCall[] } {
  const calls: Call[] = [];
  const { calls: execCalls, exec } = scriptedExec(script);
  return {
    calls,
    execCalls,
    exec: vi.fn(exec),
    spawn: vi.fn(() => {
      throw new Error('spawn not expected');
    }),
    launch: vi.fn(async (file: string, args: readonly string[], opts?: { cwd?: string; verbatim?: boolean; hidden?: boolean }) => {
      calls.push({ file, args, opts });
      if (failFiles.includes(file)) {
        throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
      }
    }),
  };
}

const PATHS = {
  spaces: 'C:\\Users\\me\\My Projects\\shop',
  amp: 'C:\\dev\\R&D\\app',
  caret: 'C:\\dev\\a^b',
  percent: 'C:\\dev\\100%\\app',
  semicolon: 'C:\\dev\\a;b',
  trailing: 'C:\\dev\\trailing slash\\',
};

describe('win32 openInEditor', () => {
  it('runs the editor through cmd.exe with escaped arguments', async () => {
    const runner = fakeRunner();
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await adapter.openInEditor(PATHS.amp);
    expect(runner.calls[0]).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', '"code ^"C:\\dev\\R^&D\\app^""'],
      opts: { verbatim: true, hidden: true },
    });
  });

  it.each(Object.entries(PATHS))('escapes %s paths', async (_name, path) => {
    const runner = fakeRunner();
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await adapter.openInEditor(path);
    const line = runner.calls[0]?.args[3] ?? '';
    expect(line.startsWith('"code ')).toBe(true);
    // the argument part: every metacharacter must be caret-escaped (no bare & ^ % ; space or quote)
    const argPart = line.slice('"code '.length, -1);
    expect(argPart.replace(/\^./g, '')).not.toMatch(/[&^%; "]/);
  });

  it('uses -g path:line when a line is given', async () => {
    const runner = fakeRunner();
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await adapter.openInEditor('C:\\a\\b.ts', 12);
    expect(runner.calls[0]?.args[3]).toBe('"code ^"-g^" ^"C:\\a\\b.ts:12^""');
  });

  it('reports an INTERNAL error when cmd.exe cannot start', async () => {
    const runner = fakeRunner(['cmd.exe']);
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await expect(adapter.openInEditor('C:\\a')).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid line %s with VALIDATION', async (line) => {
    const runner = fakeRunner();
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await expect(adapter.openInEditor('C:\\a', line)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(runner.launch).not.toHaveBeenCalled();
  });

  it('rejects an unsafe path with VALIDATION and never calls the runner', async () => {
    const runner = fakeRunner();
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await expect(adapter.openInEditor('C:\\a"b')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(runner.launch).not.toHaveBeenCalled();
  });
});

describe('win32 openInEditor pre-check', () => {
  it('checks the editor with where.exe before launching', async () => {
    const runner = fakeRunner();
    await createWin32Adapter({ runner, getEditorCommand: () => 'code' }).openInEditor('C:\\a');
    expect(runner.execCalls).toEqual([{ file: 'where.exe', args: ['/q', 'code'] }]);
    expect(runner.launch).toHaveBeenCalledTimes(1);
  });

  it('reports NOT_FOUND with a helpful message when the editor is not on PATH', async () => {
    const runner = fakeRunner([], { 'where.exe': { code: 1, stdout: '' } });
    await expect(
      createWin32Adapter({ runner, getEditorCommand: () => 'code' }).openInEditor('C:\\a'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Editor command "code" was not found on PATH. Change it in Settings.',
    });
    expect(runner.launch).not.toHaveBeenCalled();
  });

  it('checks an editor given as a path with the dir:pattern form', async () => {
    const runner = fakeRunner();
    const editor = 'C:\\Tools\\ed it\\code.cmd';
    await createWin32Adapter({ runner, getEditorCommand: () => editor }).openInEditor('C:\\a');
    expect(runner.execCalls[0]).toEqual({ file: 'where.exe', args: ['/q', 'C:\\Tools\\ed it:code.cmd'] });
  });

  it('skips the check when where.exe itself cannot run', async () => {
    const runner = fakeRunner([], { 'where.exe': Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
    await createWin32Adapter({ runner, getEditorCommand: () => 'code' }).openInEditor('C:\\a');
    expect(runner.launch).toHaveBeenCalledTimes(1);
  });

  it('validates the path before running where.exe', async () => {
    const runner = fakeRunner();
    await expect(
      createWin32Adapter({ runner, getEditorCommand: () => 'code' }).openInEditor('C:\\a"b'),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(runner.execCalls).toEqual([]);
  });
});

describe('win32 commandExists', () => {
  it.each([
    [{ code: 0, stdout: '' }, true],
    [{ code: 1, stdout: '' }, false],
    [new Error('ENOENT'), null],
  ] as const)('maps where.exe %j to %s', async (result, expected) => {
    const runner = fakeRunner([], { 'where.exe': result });
    expect(await createWin32Adapter({ runner, getEditorCommand: () => 'code' }).commandExists('cursor')).toBe(expected);
    expect(runner.execCalls).toEqual([{ file: 'where.exe', args: ['/q', 'cursor'] }]);
  });
});

describe('win32 openInEditor with a path that has spaces', () => {
  it('passes the editor path through cmd with its spaces escaped', async () => {
    const runner = fakeRunner();
    const editor = 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd';
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => editor });
    await adapter.openInEditor('C:\\Dev\\Shop');
    expect(runner.calls[0]?.args[3]).toBe('"C:\\Program^ Files\\Microsoft^ VS^ Code\\bin\\code.cmd ^"C:\\Dev\\Shop^""');
  });
});

describe('win32 openTerminal', () => {
  it.each(Object.entries(PATHS))('opens Windows Terminal with an escaped -d for %s paths', async (_n, path) => {
    const runner = fakeRunner();
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await adapter.openTerminal(path);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toEqual({
      file: 'wt.exe',
      args: ['-d', path.replace(/;/g, '\\;')],
      opts: undefined,
    });
  });

  it('runs a command in the new tab via cmd /k, escaping ;', async () => {
    const runner = fakeRunner();
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await adapter.openTerminal('C:\\a', 'echo one; echo two');
    expect(runner.calls[0]?.args).toEqual(['-d', 'C:\\a', 'cmd.exe', '/d', '/k', 'echo one\\; echo two']);
  });

  it.each(Object.entries(PATHS))('falls back to cmd /K with the path as cwd for %s paths', async (_n, path) => {
    const runner = fakeRunner(['wt.exe']);
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await adapter.openTerminal(path);
    expect(runner.calls[1]).toEqual({
      file: 'cmd.exe',
      args: ['/d /c start "" cmd.exe /d /k'],
      opts: { cwd: path, verbatim: true },
    });
    // the path must never be spliced into the cmd command line
    expect(runner.calls[1]?.args.join(' ')).not.toContain(path);
  });

  it('falls back to cmd /s /k with the command line verbatim and the path as cwd', async () => {
    const runner = fakeRunner(['wt.exe']);
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await adapter.openTerminal('C:\\a', 'echo one; echo two');
    expect(runner.calls[1]).toEqual({
      file: 'cmd.exe',
      args: ['/d /c start "" cmd.exe /d /s /k "echo one; echo two"'],
      opts: { cwd: 'C:\\a', verbatim: true },
    });
  });

  it('opens Claude Code and continues the last session', async () => {
    const runner = fakeRunner();
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await adapter.openTerminal('C:\\a', 'claude --continue');
    expect(runner.calls[0]?.args).toEqual(['-d', 'C:\\a', 'cmd.exe', '/d', '/k', 'claude --continue']);
  });

  it('goes straight to cmd when the terminal setting says so', async () => {
    const runner = fakeRunner();
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code', getTerminalApp: () => 'cmd' });
    await adapter.openTerminal('C:\\a', 'claude');
    expect(runner.calls).toEqual([{ file: 'cmd.exe', args: ['/d /c start "" cmd.exe /d /s /k "claude"'], opts: { cwd: 'C:\\a', verbatim: true } }]);
  });

  it('rejects % in a command: the start fallback would expand %VAR% twice', async () => {
    const runner = fakeRunner(['wt.exe']);
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await expect(adapter.openTerminal('C:\\a', 'echo %PATH%')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(runner.launch).not.toHaveBeenCalled();
  });

  it('rejects an unsafe command with VALIDATION and never calls the runner', async () => {
    const runner = fakeRunner();
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await expect(adapter.openTerminal('C:\\a', 'x"y')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(runner.launch).not.toHaveBeenCalled();
  });

  it('reports INTERNAL when both wt and the cmd fallback fail', async () => {
    const runner: CommandRunner = {
      ...noopRunner,
      launch: vi.fn(async (file: string) => {
        if (file === 'wt.exe') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw new Error('boom');
      }),
    };
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await expect(adapter.openTerminal('C:\\a')).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('does not fall back on errors other than ENOENT', async () => {
    const runner: CommandRunner = { ...noopRunner, launch: vi.fn().mockRejectedValue(new Error('EACCES')) };
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await expect(adapter.openTerminal('C:\\a')).rejects.toBeInstanceOf(NestboxError);
    expect(runner.launch).toHaveBeenCalledTimes(1);
  });
});

describe('win32 other members', () => {
  const adapter = createWin32Adapter({ runner: fakeRunner(), getEditorCommand: () => 'code' });

  it('compares paths case-insensitively and ignores trailing separators', () => {
    expect(adapter.samePath('C:\\Dev\\Shop', 'c:\\dev\\shop\\')).toBe(true);
    expect(adapter.samePath('C:\\Dev\\Shop', 'C:\\Dev\\Shop2')).toBe(false);
  });

  it('uses a native title bar overlay', () => {
    expect(adapter.windowChrome({ color: 'a', symbolColor: 'b', height: 40 })).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: 'a', symbolColor: 'b', height: 40 },
    });
  });

  it('uses the installer appId for notifications', () => {
    expect(adapter.notificationAppId()).toBe('dev.nestbox.app');
  });

  it('runs python and finds a virtualenv\'s Scripts folder', () => {
    expect(adapter.pythonCommand).toBe('python');
    expect(adapter.venvBinDir('C:\\Dev\\shop\\backend\\.venv')).toBe('C:\\Dev\\shop\\backend\\.venv\\Scripts');
  });

  it('returns a copy of the inherited environment', async () => {
    const env = await adapter.resolveShellEnv();
    expect(env).toEqual(process.env);
    expect(env).not.toBe(process.env);
  });
});

describe('win32 execCommand', () => {
  it('runs through cmd.exe verbatim in the given folder and returns the result', async () => {
    const runner = fakeRunner([], { 'cmd.exe': { code: 0, stdout: '2.1.0 (Claude Code)\r\n' } });
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    expect(await adapter.execCommand('claude', ['--version'], { cwd: 'C:\\a', timeoutMs: 10_000 })).toEqual({
      code: 0,
      stdout: '2.1.0 (Claude Code)\r\n',
    });
    expect(runner.exec).toHaveBeenCalledWith('cmd.exe', cmdInvocation('claude', ['--version']).args, {
      cwd: 'C:\\a',
      timeoutMs: 10_000,
      verbatim: true,
      env: expect.objectContaining({ NoDefaultCurrentDirectoryInExePath: '1' }),
    });
  });

  it('never runs a program from the folder it runs in (a git.bat in a cloned repo)', async () => {
    const runner = fakeRunner([], { 'cmd.exe': { code: 0, stdout: '' } });
    await createWin32Adapter({ runner, getEditorCommand: () => 'code' }).execCommand('git', ['status'], { cwd: 'C:\\repo', timeoutMs: 1_000 });
    const env = vi.mocked(runner.exec).mock.calls[0]?.[2]?.env;
    // cmd.exe searches the current folder before PATH unless this is set.
    expect(env?.['NoDefaultCurrentDirectoryInExePath']).toBe('1');
    expect(env?.['PATH'] ?? env?.['Path']).toBe(process.env['PATH'] ?? process.env['Path']);
  });

  it('adds extra env variables on top of the process env', async () => {
    const runner = fakeRunner([], { 'cmd.exe': { code: 0, stdout: '' } });
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await adapter.execCommand('pnpm', ['--version'], { cwd: 'C:\\a', timeoutMs: 1_000, env: { COREPACK_ENABLE_NETWORK: '0' } });
    const env = vi.mocked(runner.exec).mock.calls[0]?.[2]?.env;
    expect(env).toMatchObject({ COREPACK_ENABLE_NETWORK: '0', NoDefaultCurrentDirectoryInExePath: '1' });
  });

  it('passes an output cap to the runner', async () => {
    const runner = fakeRunner([], { 'cmd.exe': { code: 0, stdout: '' } });
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    await adapter.execCommand('git', ['status'], { cwd: 'C:\\a', timeoutMs: 10_000, maxBytes: 2_000_000 });
    expect(runner.exec).toHaveBeenCalledWith('cmd.exe', expect.anything(), expect.objectContaining({ maxBytes: 2_000_000 }));
  });
});

describe('win32 spawnCommand', () => {
  it('runs the command found on PATH through cmd.exe and hands stdin to the runner', () => {
    const runner = fakeRunner();
    const child = {} as ChildProcess;
    vi.mocked(runner.spawn).mockReturnValue(child);
    const env = { PATH: 'C:\\npm' };
    const resolveCommand = vi.fn(() => 'C:\\npm\\claude.cmd');
    const result = createWin32Adapter({ runner, getEditorCommand: () => 'code', resolveCommand }).spawnCommand({
      cwd: 'C:\\a',
      command: 'claude',
      args: ['-p'],
      env,
      stdin: 'what does "this" do?',
    });
    expect(result).toBe(child);
    expect(resolveCommand).toHaveBeenCalledWith('claude', env);
    expect(runner.spawn).toHaveBeenCalledWith('cmd.exe', cmdInvocation('C:\\npm\\claude.cmd', ['-p']).args, {
      cwd: 'C:\\a',
      env,
      verbatim: true,
      stdin: 'what does "this" do?',
    });
  });

  it("keeps cmd.exe out of the project folder when the command isn't on PATH", () => {
    const runner = fakeRunner();
    vi.mocked(runner.spawn).mockReturnValue({} as ChildProcess);
    createWin32Adapter({ runner, getEditorCommand: () => 'code', resolveCommand: () => null }).spawnCommand({
      cwd: 'C:\\a',
      command: 'docker',
      args: ['compose'],
      env: { PATH: 'x' },
    });
    expect(runner.spawn).toHaveBeenCalledWith('cmd.exe', cmdInvocation('docker', ['compose']).args, {
      cwd: 'C:\\a',
      env: { PATH: 'x', NoDefaultCurrentDirectoryInExePath: '1' },
      verbatim: true,
    });
  });

  it('refuses quotes in the command line itself', () => {
    const adapter = createWin32Adapter({ runner: fakeRunner(), getEditorCommand: () => 'code' });
    expect(() => adapter.spawnCommand({ cwd: 'C:\\', command: 'claude', args: ['"x"'], env: {} })).toThrow(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
  });
});

describe('win32 spawnScript', () => {
  it('runs the package manager through cmd.exe with escaped arguments', () => {
    const runner = fakeRunner();
    const child = {} as ChildProcess;
    vi.mocked(runner.spawn).mockReturnValue(child);
    const env = { PATH: 'x', FORCE_COLOR: '1' };
    const result = createWin32Adapter({ runner, getEditorCommand: () => 'code' }).spawnScript({
      cwd: 'C:\\a b',
      command: 'pnpm',
      args: ['run', 'dev:api'],
      env,
    });
    expect(result).toBe(child);
    const inv = cmdInvocation('pnpm', ['run', 'dev:api']);
    expect(inv.args).toEqual(['/d', '/s', '/c', '"pnpm ^"run^" ^"dev:api^""']);
    expect(runner.spawn).toHaveBeenCalledWith('cmd.exe', inv.args, { cwd: 'C:\\a b', env, verbatim: true });
  });

  it('rejects a script name with a quote before spawning', () => {
    const runner = fakeRunner();
    const adapter = createWin32Adapter({ runner, getEditorCommand: () => 'code' });
    expect(() => adapter.spawnScript({ cwd: 'C:\\', command: 'pnpm', args: ['run', 'a"b'], env: {} })).toThrow(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
    expect(runner.spawn).not.toHaveBeenCalled();
  });
});

describe('win32 killTree', () => {
  it('runs taskkill for the whole tree', async () => {
    const runner = fakeRunner();
    await createWin32Adapter({ runner, getEditorCommand: () => 'code' }).killTree(4321);
    expect(runner.execCalls).toEqual([{ file: 'taskkill.exe', args: ['/PID', '4321', '/T', '/F'] }]);
  });

  it('treats "process not found" (128) as success', async () => {
    const runner = fakeRunner([], { 'taskkill.exe': { code: 128, stdout: '' } });
    await expect(createWin32Adapter({ runner, getEditorCommand: () => 'code' }).killTree(4321)).resolves.toBeUndefined();
  });

  it('reports other failures as INTERNAL without the output', async () => {
    const runner = fakeRunner([], { 'taskkill.exe': { code: 1, stdout: 'ERROR: Access is denied.' } });
    await expect(createWin32Adapter({ runner, getEditorCommand: () => 'code' }).killTree(4321)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'Could not stop the process tree',
    });
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects pid %s without running anything', async (pid) => {
    const runner = fakeRunner();
    await expect(createWin32Adapter({ runner, getEditorCommand: () => 'code' }).killTree(pid)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(runner.execCalls).toEqual([]);
  });
});

describe('win32 listProcesses', () => {
  const script =
    "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o') } }";

  it('lists every process with its parent and start time through one PowerShell call', async () => {
    const stdout = '4 0 2026-10-01T09:00:00.0000000Z\r\n4321 812 2026-10-01T10:00:00.1234567Z\r\njunk\r\n';
    const runner = fakeRunner([], { 'powershell.exe': { code: 0, stdout } });
    expect(await createWin32Adapter({ runner, getEditorCommand: () => 'code' }).listProcesses()).toEqual([
      { pid: 4, parentPid: 0, startTime: Date.parse('2026-10-01T09:00:00.000Z') },
      { pid: 4321, parentPid: 812, startTime: Date.parse('2026-10-01T10:00:00.123Z') },
    ]);
    expect(runner.execCalls).toEqual([{ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] }]);
    // A cold PowerShell on a loaded machine can take over 30 s.
    expect(vi.mocked(runner.exec).mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 60_000 });
  });

  it.each([
    ['a non-zero exit', { code: 1, stdout: '' }],
    ['no processes in the output', { code: 0, stdout: 'nope' }],
    ['a failure to start', new Error('ENOENT')],
  ])('returns null on %s', async (_label, result) => {
    const runner = fakeRunner([], { 'powershell.exe': result });
    expect(await createWin32Adapter({ runner, getEditorCommand: () => 'code' }).listProcesses()).toBeNull();
  });
});

describe('win32 listListeningPorts', () => {
  const read = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
  const script: ExecScript = {
    'netstat.exe': (args) => ({ code: 0, stdout: read(args.includes('TCPv6') ? 'netstat-tcpv6.txt' : 'netstat-tcp.txt') }),
    'tasklist.exe': { code: 0, stdout: read('tasklist.csv') },
  };

  it('joins both netstat calls with tasklist names, one row per port and PID', async () => {
    const runner = fakeRunner([], script);
    const rows = await createWin32Adapter({ runner, getEditorCommand: () => 'code' }).listListeningPorts();
    expect(rows.find((r) => r.port === 3000)).toEqual({ port: 3000, pid: 8108, addresses: ['0.0.0.0', '::'], processName: 'node.exe' });
    expect(rows.find((r) => r.port === 5432)).toEqual({ port: 5432, pid: 5120, addresses: ['::1'], processName: null });
    expect(rows.map((r) => r.port)).toEqual([135, 3000, 5000, 5000, 5353, 5432, 6379, 8080]);
    expect(runner.execCalls.map((c) => [c.file, ...c.args])).toEqual(
      expect.arrayContaining([
        ['netstat.exe', '-ano', '-p', 'TCP'],
        ['netstat.exe', '-ano', '-p', 'TCPv6'],
        ['tasklist.exe', '/FO', 'CSV', '/NH'],
      ]),
    );
  });

  it('still lists ports when tasklist fails, without names', async () => {
    const runner = fakeRunner([], { ...script, 'tasklist.exe': { code: 1, stdout: '' } });
    const rows = await createWin32Adapter({ runner, getEditorCommand: () => 'code' }).listListeningPorts();
    expect(rows.every((r) => r.processName === null)).toBe(true);
  });

  it('throws INTERNAL when netstat fails', async () => {
    const runner = fakeRunner([], { ...script, 'netstat.exe': { code: 1, stdout: '' } });
    await expect(createWin32Adapter({ runner, getEditorCommand: () => 'code' }).listListeningPorts()).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'Could not list ports',
    });
  });
});

describe('win32 describeProcesses', () => {
  it('reads command lines for the given PIDs in one PowerShell call', async () => {
    const stdout = '8108\tnode  server.js --port 3000\r\n4420\t\r\n';
    const runner = fakeRunner([], { 'powershell.exe': { code: 0, stdout } });
    const result = await createWin32Adapter({ runner, getEditorCommand: () => 'code' }).describeProcesses([8108, 4420, 7]);
    expect(result).toEqual(
      new Map([
        [8108, 'node  server.js --port 3000'],
        [4420, null],
        [7, null],
      ]),
    );
    expect(runner.execCalls).toHaveLength(1);
    expect(runner.execCalls[0]?.args.at(-1)).toContain('ProcessId=8108 OR ProcessId=4420 OR ProcessId=7');
  });

  it('returns an empty map for no PIDs without running anything', async () => {
    const runner = fakeRunner();
    expect(await createWin32Adapter({ runner, getEditorCommand: () => 'code' }).describeProcesses([])).toEqual(new Map());
    expect(runner.execCalls).toEqual([]);
  });

  it('rejects invalid or too many PIDs', async () => {
    const adapter = createWin32Adapter({ runner: fakeRunner(), getEditorCommand: () => 'code' });
    await expect(adapter.describeProcesses([0])).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(adapter.describeProcesses(Array.from({ length: 65 }, (_, i) => i + 1))).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('maps every PID to null when PowerShell fails', async () => {
    const runner = fakeRunner([], { 'powershell.exe': new Error('ENOENT') });
    expect(await createWin32Adapter({ runner, getEditorCommand: () => 'code' }).describeProcesses([5])).toEqual(new Map([[5, null]]));
  });
});
