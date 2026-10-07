import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { NestboxError } from '@shared/errors';
import type { Logger } from '../logger';
import type { PlatformAdapter, PlatformDeps } from './adapter';
import { parseLsof } from './darwin-ports';
import { parsePsCommands, parsePsList } from './darwin-ps';
import { assertTerminalCommand, chooseTerminal, commandFileScript, loginShell, openArgs } from './darwin-terminal';
import { normalizeDarwinPath } from './paths';
import { killProcessTree } from './posix-kill';
import { createShellEnv, findOnPath, type ShellEnv } from './posix-shell';
import { groupSockets } from './sockets';

// System tools by absolute path: they never depend on the user's PATH.
const LSOF = '/usr/sbin/lsof';
const PS = '/bin/ps';
const OPEN = '/usr/bin/open';
const MAX_DESCRIBE_PIDS = 64;
/** The .command file deletes itself when it runs; this removes it if the terminal never started. */
const COMMAND_FILE_TTL_MS = 60_000;

/** Test seams; production uses the real process, filesystem and timers. */
export interface DarwinExtras {
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
  exists?: (path: string) => Promise<boolean>;
  writeScript?: (path: string, text: string) => Promise<void>;
  shellEnv?: ShellEnv;
  now?: () => number;
}

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new NestboxError('VALIDATION', 'Invalid process id');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeExecutable(path: string, text: string): Promise<void> {
  // wx: never follow or overwrite something already at the (random) path.
  await writeFile(path, text, { mode: 0o700, flag: 'wx' });
  await chmod(path, 0o700);
}

export function createDarwinAdapter(deps: PlatformDeps, extras: DarwinExtras = {}): PlatformAdapter {
  const logger = deps.logger ?? silent;
  const kill = extras.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => void process.kill(pid, signal));
  const sleep = extras.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const exists = extras.exists ?? pathExists;
  const writeScript = extras.writeScript ?? writeExecutable;
  const now = extras.now ?? Date.now;
  const loginEnv =
    extras.shellEnv ??
    createShellEnv({ runner: deps.runner, shell: loginShell(process.env['SHELL']), fallback: process.env, logger, now });
  // A login shell rebuilds PATH with the system folders first, which would hide the end-to-end fakes.
  const shellEnv = {
    get: async () => {
      const env = await loginEnv.get();
      // POSIX PATH: ':' even when this adapter runs in tests on Windows (node:path's delimiter would be ';').
      return deps.pathPrepend ? { ...env, PATH: `${deps.pathPrepend}:${env['PATH'] ?? ''}` } : env;
    },
  };
  // ps output is parsed: keep it in the C locale whatever the user's language is.
  const cLocale = () => ({ ...process.env, LC_ALL: 'C' });

  async function listProcesses() {
    try {
      const { code, stdout } = await deps.runner.exec(PS, ['-axo', 'pid=,ppid=,pgid=,etime='], {
        timeoutMs: 10_000,
        maxBytes: 8 * 1024 * 1024,
        env: cLocale(),
      });
      if (code !== 0) return null;
      const processes = parsePsList(stdout, now());
      return processes.length > 0 ? processes : null;
    } catch {
      return null;
    }
  }

  async function commandPath(command: string): Promise<string | null> {
    return findOnPath(command, (await shellEnv.get())['PATH'] ?? '');
  }

  /** Runs /usr/bin/open, which returns at once and exits non-zero when the app or bundle is missing. */
  async function open(args: string[]): Promise<boolean> {
    try {
      return (await deps.runner.exec(OPEN, args, { timeoutMs: 10_000 })).code === 0;
    } catch {
      return false;
    }
  }

  async function installedApp(name: string): Promise<boolean> {
    return (await exists(`/Applications/${name}.app`)) || exists(join(homedir(), 'Applications', `${name}.app`));
  }

  return {
    id: 'darwin',

    async listListeningPorts() {
      let result;
      try {
        result = await deps.runner.exec(LSOF, ['-nP', '-iTCP', '-sTCP:LISTEN', '+c', '0', '-F', 'pcftn'], {
          timeoutMs: 10_000,
          maxBytes: 4 * 1024 * 1024,
        });
      } catch {
        throw new NestboxError('INTERNAL', 'Could not list ports');
      }
      // lsof exits 1 with no output when nothing listens.
      if (result.code !== 0 && !(result.code === 1 && result.stdout.trim() === '')) {
        throw new NestboxError('INTERNAL', 'Could not list ports');
      }
      const { sockets, names } = parseLsof(result.stdout);
      return groupSockets(sockets).map((s) => ({ ...s, processName: names.get(s.pid) ?? null }));
    },

    async describeProcesses(pids) {
      if (pids.length > MAX_DESCRIBE_PIDS) throw new NestboxError('VALIDATION', 'Too many processes');
      pids.forEach(assertPid);
      const result = new Map<number, string | null>(pids.map((pid) => [pid, null]));
      if (pids.length === 0) return result;
      try {
        const { stdout } = await deps.runner.exec(PS, ['-ww', '-o', 'pid=,command=', '-p', pids.join(',')], {
          timeoutMs: 10_000,
          maxBytes: 1024 * 1024,
          env: cLocale(),
        });
        // ps exits 1 when some PIDs are gone; the others are still listed.
        for (const [pid, command] of parsePsCommands(stdout)) if (result.has(pid)) result.set(pid, command);
      } catch {
        // ps missing or blocked: command lines stay unknown.
      }
      return result;
    },

    async killTree(pid) {
      assertPid(pid);
      await killProcessTree(pid, { kill, list: listProcesses, sleep });
    },

    listProcesses,

    /** `<pm> run <script>` without a shell, as the leader of a new process group (so killTree reaches the tree). */
    spawnScript(opts) {
      return deps.runner.spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, newProcessGroup: true });
    },

    spawnCommand(opts) {
      return deps.runner.spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        newProcessGroup: true,
        ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
      });
    },

    async execCommand(command, args, opts) {
      const env = { ...(await shellEnv.get()), ...opts.env };
      // Resolved here: a bare name would otherwise be looked up on the app's own minimal PATH.
      const file = (await commandPath(command)) ?? command;
      return deps.runner.exec(file, args, { ...opts, env });
    },

    async openInEditor(path, line) {
      if (line !== undefined && !(Number.isInteger(line) && line > 0)) {
        throw new NestboxError('VALIDATION', 'Line must be a positive integer');
      }
      const editor = deps.getEditorCommand();
      const args = line === undefined ? [path] : ['-g', `${path}:${line}`];
      const resolved = await commandPath(editor);
      if (resolved) {
        try {
          await deps.runner.launch(resolved, args);
          return;
        } catch {
          throw new NestboxError('INTERNAL', `Could not start the editor command "${editor}"`);
        }
      }
      // VS Code without its `code` command on PATH: its URL handler, which also reaches a running VS Code.
      if (editor === 'code') {
        const url = `vscode://file${path.split('/').map(encodeURIComponent).join('/')}${line === undefined ? '' : `:${line}`}`;
        if (await open([url])) return;
      }
      // The editor name is a setting, not an IPC payload, so it may appear in the message.
      throw new NestboxError('NOT_FOUND', `Editor command "${editor}" was not found on PATH. Change it in Settings.`);
    },

    async openTerminal(cwd, command) {
      if (command !== undefined) assertTerminalCommand(command);
      const app = chooseTerminal(deps.getTerminalApp?.() ?? 'auto', {
        iterm: await installedApp('iTerm'),
        ghostty: await installedApp('Ghostty'),
      });
      let commandFile: string | undefined;
      if (command !== undefined && app !== 'ghostty') {
        commandFile = join(tmpdir(), `nestbox-${randomUUID()}.command`);
        await writeScript(commandFile, commandFileScript(cwd, command));
        const file = commandFile;
        setTimeout(() => void rm(file, { force: true }).catch(() => undefined), COMMAND_FILE_TTL_MS).unref();
      }
      const args = openArgs(app, {
        cwd,
        shell: loginShell(process.env['SHELL']),
        ...(command === undefined ? {} : { command }),
        ...(commandFile ? { commandFile } : {}),
      });
      if (!(await open(args))) throw new NestboxError('INTERNAL', 'Could not open a terminal');
    },

    resolveShellEnv: () => shellEnv.get(),

    normalizePath: normalizeDarwinPath,
    samePath: (a, b) => normalizeDarwinPath(a) === normalizeDarwinPath(b),

    windowChrome: () => ({ titleBarStyle: 'hiddenInset' }),

    notificationAppId: () => null,

    commandExists: async (command) => (await commandPath(command)) !== null,

    // macOS has no `python` unless the user installed one; Apple's and Homebrew's are python3.
    pythonCommand: 'python3',

    venvBinDir: (venvPath) => posix.join(venvPath, 'bin'),
  };
}
