import { win32 } from 'node:path';
import { NestboxError } from '@shared/errors';
import { type CommandRunner, type ExecResult, type PlatformAdapter, type PlatformDeps, type ProcessInfo } from './adapter';
import { normalizeWin32Path } from './paths';
import { groupSockets, parseNetstat, parseTasklist } from './win32-ports';
import { assertCmdSafe, cmdInvocation, escapeWtArg } from './win32-escape';
import { resolveOnPath } from './win32-resolve';

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Asks `where` whether a command exists. A command given as a path uses where's `dir:pattern` form.
 * null when where.exe itself cannot run (then nobody can tell).
 */
async function commandExists(runner: CommandRunner, command: string): Promise<boolean | null> {
  const sep = Math.max(command.lastIndexOf('\\'), command.lastIndexOf('/'));
  const query = sep === -1 ? command : `${command.slice(0, sep)}:${command.slice(sep + 1)}`;
  let result: ExecResult;
  try {
    result = await runner.exec('where.exe', ['/q', query], { timeoutMs: 5_000 });
  } catch {
    return null;
  }
  return result.code === 0;
}

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new NestboxError('VALIDATION', 'Invalid process id');
}

const MAX_DESCRIBE_PIDS = 64;
export const LIST_PROCESSES_TIMEOUT_MS = 60_000;

export function createWin32Adapter(deps: PlatformDeps): PlatformAdapter {
  return {
    id: 'win32',

    async listListeningPorts() {
      const big = { timeoutMs: 10_000, maxBytes: 4 * 1024 * 1024 };
      const [v4, v6, tasks] = await Promise.all([
        deps.runner.exec('netstat.exe', ['-ano', '-p', 'TCP'], big).catch(() => null),
        deps.runner.exec('netstat.exe', ['-ano', '-p', 'TCPv6'], big).catch(() => null),
        deps.runner.exec('tasklist.exe', ['/FO', 'CSV', '/NH'], big).catch(() => null),
      ]);
      if (v4?.code !== 0 || v6?.code !== 0) throw new NestboxError('INTERNAL', 'Could not list ports');
      // Names are a nicety: without tasklist the ports are still listed.
      const names = tasks?.code === 0 ? parseTasklist(tasks.stdout) : new Map<number, string>();
      return groupSockets([...parseNetstat(v4.stdout), ...parseNetstat(v6.stdout)]).map((s) => ({
        ...s,
        processName: names.get(s.pid) ?? null,
      }));
    },

    async describeProcesses(pids) {
      if (pids.length > MAX_DESCRIBE_PIDS) throw new NestboxError('VALIDATION', 'Too many processes');
      pids.forEach(assertPid);
      const result = new Map<number, string | null>(pids.map((pid) => [pid, null]));
      if (pids.length === 0) return result;
      // The filter is built from validated integers only.
      const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
      const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`;
      try {
        const { code, stdout } = await deps.runner.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          timeoutMs: 30_000,
          maxBytes: 1024 * 1024,
        });
        if (code !== 0) return result;
        for (const line of stdout.split(/\r?\n/)) {
          const tab = line.indexOf('\t');
          const pid = Number(line.slice(0, tab));
          if (tab < 0 || !result.has(pid)) continue;
          const command = line.slice(tab + 1).trim();
          result.set(pid, command === '' ? null : command);
        }
      } catch {
        // PowerShell missing or blocked: command lines stay unknown.
      }
      return result;
    },

    /** npm, pnpm and yarn are .cmd shims, which current Node refuses to spawn directly: go through cmd.exe. */
    spawnScript(opts) {
      const inv = cmdInvocation(opts.command, opts.args);
      return deps.runner.spawn(inv.file, inv.args, { cwd: opts.cwd, env: opts.env, verbatim: true });
    },

    execCommand(command, args, opts) {
      const inv = cmdInvocation(command, args);
      // cmd.exe looks in the current folder before PATH: without this, a git.bat in a cloned repository
      // would run just because NestBox read its status. Only for short-lived commands: scripts may rely on it.
      const env = { ...process.env, ...opts.env, NoDefaultCurrentDirectoryInExePath: '1' };
      return deps.runner.exec(inv.file, inv.args, { ...opts, env, verbatim: true });
    },

    spawnCommand(opts) {
      // cwd is the user's project: run the program found on PATH, never one sitting in the project folder.
      // The env (and so the children's lookup) stays as it is, because their own scripts may rely on it.
      const resolved = (deps.resolveCommand ?? resolveOnPath)(opts.command, opts.env);
      const inv = cmdInvocation(resolved ?? opts.command, opts.args);
      return deps.runner.spawn(inv.file, inv.args, {
        cwd: opts.cwd,
        // Not on PATH: cmd.exe would try the current folder first. It fails with "not recognized" instead.
        env: resolved === null ? { ...opts.env, NoDefaultCurrentDirectoryInExePath: '1' } : opts.env,
        verbatim: true,
        ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
      });
    },

    async killTree(pid) {
      assertPid(pid);
      const { code } = await deps.runner.exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10_000 });
      // 128: no such process, which is the outcome we wanted.
      if (code !== 0 && code !== 128) throw new NestboxError('INTERNAL', 'Could not stop the process tree');
    },

    async listProcesses() {
      // CreationDate is null for the System Idle process.
      const script =
        "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o') } }";
      try {
        const { code, stdout } = await deps.runner.exec(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          // A cold PowerShell on a loaded machine can take over 30 s (seen on a CI runner); callers run it in the
          // background. A busy machine lists thousands of processes: lift the 64 KiB cap.
          { timeoutMs: LIST_PROCESSES_TIMEOUT_MS, maxBytes: 8 * 1024 * 1024 },
        );
        if (code !== 0) return null;
        const processes: ProcessInfo[] = [];
        for (const line of stdout.split(/\r?\n/)) {
          const match = /^(\d+) (\d+) (\S+)$/.exec(line.trim());
          if (!match) continue;
          // .NET's round-trip format has 7 fractional digits; Date.parse wants at most 3.
          const startTime = Date.parse((match[3] ?? '').replace(/(\.\d{3})\d+/, '$1'));
          if (Number.isFinite(startTime)) {
            processes.push({ pid: Number(match[1]), parentPid: Number(match[2]), startTime });
          }
        }
        return processes.length > 0 ? processes : null;
      } catch {
        return null;
      }
    },

    /**
     * Runs the editor through cmd.exe, so a missing editor binary fails inside the console window.
     * This method only reports failures to start cmd.exe itself.
     */
    async openInEditor(path, line) {
      if (line !== undefined && !(Number.isInteger(line) && line > 0)) {
        throw new NestboxError('VALIDATION', 'Line must be a positive integer');
      }
      const editor = deps.getEditorCommand();
      const args = line === undefined ? [path] : ['-g', `${path}:${line}`];
      // Outside the try: a VALIDATION error from unsafe input must not become NOT_FOUND.
      const inv = cmdInvocation(editor, args);
      if ((await commandExists(deps.runner, editor)) === false) {
        // The editor name is a setting, not an IPC payload, so it may appear in the message.
        throw new NestboxError('NOT_FOUND', `Editor command "${editor}" was not found on PATH. Change it in Settings.`);
      }
      try {
        await deps.runner.launch(inv.file, inv.args, { verbatim: true, hidden: true });
      } catch {
        throw new NestboxError('INTERNAL', `Could not start the editor command "${editor}"`);
      }
    },

    async openTerminal(cwd, command) {
      if (command !== undefined) {
        assertCmdSafe(command);
        // The cmd fallback goes through `cmd /c start … cmd /k`, which expands %VAR% twice. Commands
        // here are NestBox-built (`claude`, `claude --continue`), so % is simply refused.
        if (command.includes('%')) throw new NestboxError('VALIDATION', 'Terminal commands cannot contain %');
      }
      // 'cmd' skips Windows Terminal; anything else tries it first and falls back to cmd when it is missing.
      if (deps.getTerminalApp?.() !== 'cmd') {
        const wtArgs = ['-d', escapeWtArg(cwd)];
        if (command !== undefined) wtArgs.push('cmd.exe', '/d', '/k', escapeWtArg(command));
        try {
          await deps.runner.launch('wt.exe', wtArgs);
          return;
        } catch (error) {
          if (!isEnoent(error)) throw new NestboxError('INTERNAL', 'Could not start Windows Terminal');
        }
      }
      // Fallback: `start` gives the console its own window and handles (a detached cmd with
      // ignored stdio reads EOF and exits at once). The folder goes through cwd, never the command line.
      const line =
        command === undefined
          ? '/d /c start "" cmd.exe /d /k'
          : `/d /c start "" cmd.exe /d /s /k "${command}"`;
      try {
        await deps.runner.launch('cmd.exe', [line], { cwd, verbatim: true });
      } catch {
        throw new NestboxError('INTERNAL', 'Could not open a terminal');
      }
    },

    resolveShellEnv: async () => ({ ...process.env }),

    normalizePath: normalizeWin32Path,
    samePath: (a, b) => normalizeWin32Path(a) === normalizeWin32Path(b),

    windowChrome: (colors) => ({ titleBarStyle: 'hidden', titleBarOverlay: colors }),

    notificationAppId: () => 'dev.nestbox.app',

    commandExists: (command) => commandExists(deps.runner, command),

    pythonCommand: 'python',

    venvBinDir: (venvPath) => win32.join(venvPath, 'Scripts'),
  };
}
