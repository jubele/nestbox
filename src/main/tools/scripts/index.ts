import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCommandLine } from '@shared/command-line';
import { type DetectedProject, workspaceId } from '@shared/detected';
import { NestboxError } from '@shared/errors';
import { isLive, type LogLine, type ProcessState, type ProcessSummary } from '@shared/processes';
import {
  type ComposeStep,
  type CustomCommand,
  type ScriptKind,
  scriptsContract,
  scriptsDefinition,
  type ScriptsSettings,
  type SkippedEntry,
} from '@shared/tools/scripts/contract';
import type { RunGroup, RunGroupCompose, RunGroupEntry } from '@shared/types';
import type { Logger } from '../../logger';
import type { PlatformAdapter } from '../../platform/adapter';
import type { ProcessManager, StartRequest } from '../../processes/process-manager';
import type { SharedContext } from '../shared-context';
import { type AnyMainTool, defineMainTool, type ToolContext } from '../types';
import { exportFileName, formatExport } from './export';
import { findProjectVenvs } from './python-envs';
import { listPythonFiles } from './python-files';
import { createLogBatcher } from './log-batcher';

export interface ScriptsToolDeps {
  processes: ProcessManager;
  runGroups: {
    get(rootId: string): RunGroup[];
    set(rootId: string, groups: RunGroup[]): RunGroup[];
  };
  /** Throws NOT_FOUND for unknown ids (used to resolve run-group entries in other packages). */
  getDetected(projectId: string): DetectedProject;
  shared: SharedContext;
  saveFile(defaultName: string): Promise<string | null>;
  writeFile(path: string, text: string): Promise<void>;
  isFile(path: string): Promise<boolean>;
  emit(projectId: string, event: 'logs', payload: { script: string; lines: LogLine[] }): void;
  logger: Logger;
  /** The Node tool's advice for a start (version warning, fnm's PATH); asked before every start. */
  node: {
    advice(projectId: string): Promise<{ warning: string | null; pathPrepend: string | null; note: string | null }>;
  };
  /** The Compose tool's actions for a package (services empty = the whole stack). */
  compose: {
    up(projectId: string, services: string[], opts: { wait: boolean }): Promise<{ ok: boolean }>;
    stop(projectId: string, services: string[]): Promise<{ ok: boolean }>;
  };
  /** A package's env files (the env tool's file access): names, and one file's variables (null when missing). */
  envFiles: {
    list(dir: string): Promise<string[]>;
    read(dir: string, file: string): Promise<Record<string, string> | null>;
  };
}

/** The shared-context fact the scripts tool publishes per project (read by the M2 port manager). */
export const PROCESSES_FACT = 'scripts.processes';

const ADVICE_TIMEOUT_MS = 3_000;
/** At most this many custom commands per root project (the settings schema's cap). */
const MAX_COMMANDS = 100;

type Ctx = ToolContext<ScriptsSettings>;

/** Something a package can run: a package.json script, or a command line (detected or custom). */
interface Runnable {
  name: string;
  kind: ScriptKind;
  /** The script's text, or the command line for display. */
  command: string;
  /** null for a package.json script (`<pm> run <name>`). */
  argv: string[] | null;
}

const isEntry =
  (relPath: string, script: string | undefined) =>
  (e: RunGroupEntry): boolean =>
    e.relPath === relPath && e.script === script;

/**
 * A package's runnables in display order: package.json scripts, detected commands, custom commands. Names
 * are unique: on a clash package.json wins, then the user's command, then detection.
 */
function runnables(project: DetectedProject, settings: ScriptsSettings): Runnable[] {
  const npm: Runnable[] = Object.entries(project.packageJson?.scripts ?? {}).map(([name, command]) => ({
    name,
    kind: 'npm',
    command,
    argv: null,
  }));
  const asRunnable =
    (kind: ScriptKind) =>
    ({ name, argv }: { name: string; argv: string[] }): Runnable => ({ name, kind, command: formatCommandLine(argv), argv });
  const taken = new Set(npm.map((r) => r.name));
  const unique = (r: Runnable): boolean => !taken.has(r.name) && Boolean(taken.add(r.name));
  const custom = settings.commands.filter((c) => c.relPath === project.relPath).map(asRunnable('custom')).filter(unique);
  const detected = (project.python?.commands ?? [])
    .filter((c) => !settings.hidden.some(isEntry(project.relPath, c.name)))
    .map(asRunnable('detected'))
    .filter(unique);
  return [...npm, ...detected, ...custom];
}

/** Detected commands the user removed, unless something else now has the name. */
function hiddenOf(project: DetectedProject, settings: ScriptsSettings): { name: string; command: string }[] {
  const names = new Set(runnables(project, settings).map((r) => r.name));
  return (project.python?.commands ?? [])
    .filter((c) => settings.hidden.some(isEntry(project.relPath, c.name)) && !names.has(c.name))
    .map((c) => ({ name: c.name, command: formatCommandLine(c.argv) }));
}

/** A list of per-script settings with one package's `from` renamed to `to`. */
function renamed<T extends RunGroupEntry>(list: T[], relPath: string, from: string, to: string): T[] {
  return list.map((e) => (isEntry(relPath, from)(e) ? { ...e, script: to } : e));
}

/** The env file a runnable gets: its override, else .env for commands and none for package.json scripts. */
function envFileOf(settings: ScriptsSettings, project: DetectedProject, runnable: Runnable): string | null {
  const override = settings.envFiles.find(isEntry(project.relPath, runnable.name));
  if (override) return override.file;
  return defaultEnvFile(runnable);
}

const defaultEnvFile = (runnable: Runnable): string | null => (runnable.kind === 'npm' ? null : '.env');

const mainOf = (settings: ScriptsSettings, project: DetectedProject): string | null =>
  settings.main.find((e) => e.relPath === project.relPath)?.script ?? null;

/** A path for display and storage: posix from the project folder when inside it, else absolute as is. */
function fromRoot(rootPath: string, abs: string): string {
  const rel = relative(rootPath, abs);
  if (rel === '') return '.';
  return rel.startsWith('..') || isAbsolute(rel) ? abs : rel.split(sep).join('/');
}

/** A stored or typed path: from the project folder unless absolute. */
const resolveFromRoot = (rootPath: string, path: string): string =>
  isAbsolute(path) ? path : join(rootPath, ...path.split(/[\\/]/));

/** Which virtualenv a Python package's commands use: absolute path or null, and whether the user chose it. */
type VenvUse = { venv: string | null; chosen: boolean };

/**
 * How a command line runs in a package. With Python: unbuffered UTF-8 output and the virtualenv first on
 * PATH; without one, `python` becomes the platform's interpreter (macOS has only python3).
 */
function commandRun(
  project: DetectedProject,
  argv: string[],
  platform: Pick<PlatformAdapter, 'pythonCommand' | 'venvBinDir'>,
  use: VenvUse & { label: string | null },
): Pick<StartRequest, 'argv' | 'env' | 'pathPrepend' | 'note'> {
  if (project.python === null) return { argv };
  const env = { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
  if (use.venv !== null) {
    return {
      argv,
      env: { ...env, VIRTUAL_ENV: use.venv },
      pathPrepend: platform.venvBinDir(use.venv),
      note: `▸ virtualenv: ${use.label ?? use.venv}`,
    };
  }
  const [program, ...args] = argv;
  if (program !== 'python') return { argv, env };
  return {
    argv: [platform.pythonCommand, ...args],
    env,
    note: use.chosen
      ? `▸ System Python chosen: using ${platform.pythonCommand} from PATH`
      : `▸ No virtualenv (.venv) found: using ${platform.pythonCommand} from PATH`,
  };
}

export function createScriptsTool(deps: ScriptsToolDeps): AnyMainTool {
  const batcher = createLogBatcher({
    intervalMs: 50,
    flush: (projectId, script, lines) => deps.emit(projectId, 'logs', { script, lines }),
  });

  deps.processes.on((event) => {
    if (event.type === 'line') batcher.add(event.projectId, event.script, event.line);
    if (event.type === 'changed') publishFacts();
  });

  /** Projects with a published fact, so one whose processes are all forgotten gets an empty list. */
  let published = new Set<string>();

  function publishFacts(): void {
    const byProject = new Map<string, { script: string; pid: number | null; state: ProcessState }[]>();
    for (const p of deps.processes.list()) {
      const facts = byProject.get(p.projectId) ?? [];
      facts.push({ script: p.script, pid: p.pid, state: p.state });
      byProject.set(p.projectId, facts);
    }
    for (const projectId of published) {
      if (!byProject.has(projectId)) deps.shared.forProject(projectId).publish(PROCESSES_FACT, []);
    }
    for (const [projectId, facts] of byProject) deps.shared.forProject(projectId).publish(PROCESSES_FACT, facts);
    published = new Set(byProject.keys());
  }

  /** The project folder (the root package's path). */
  const rootPathOf = (project: DetectedProject): string =>
    project.relPath === '' ? project.path : deps.getDetected(project.rootId).path;

  const autoVenv = (project: DetectedProject): string | null =>
    project.python?.venv ? join(project.path, ...project.python.venv.split('/')) : null;

  function venvUse(settings: ScriptsSettings, project: DetectedProject): VenvUse {
    const choice = settings.venvs.find((v) => v.relPath === project.relPath);
    if (!choice) return { venv: autoVenv(project), chosen: false };
    return { venv: choice.venv === null ? null : resolveFromRoot(rootPathOf(project), choice.venv), chosen: true };
  }

  /** A package's runnables as its Scripts tab shows them. */
  const infosOf = (settings: ScriptsSettings, project: DetectedProject) => {
    const main = mainOf(settings, project);
    return runnables(project, settings).map((r) => ({
      name: r.name,
      command: r.command,
      autoRestart: isAuto(settings, project, r.name),
      kind: r.kind,
      envFile: envFileOf(settings, project, r),
      main: r.name === main,
    }));
  };

  const envFilesOf = (project: DetectedProject): Promise<string[]> => deps.envFiles.list(project.path).catch(() => []);

  const findRunnable = (project: DetectedProject, settings: ScriptsSettings, name: string): Runnable | null =>
    runnables(project, settings).find((r) => r.name === name) ?? null;

  function requireRunnable(project: DetectedProject, settings: ScriptsSettings, name: string): Runnable {
    const found = findRunnable(project, settings, name);
    if (!found) throw new NestboxError('NOT_FOUND', 'Unknown script');
    return found;
  }

  const isRunning = (projectId: string, name: string): boolean => {
    const state = deps.processes.get(projectId, name)?.state;
    return state !== undefined && isLive(state);
  };

  const isAuto = (settings: ScriptsSettings, project: DetectedProject, script: string): boolean =>
    settings.autoRestart.some((e) => e.relPath === project.relPath && e.script === script);

  /** The Node tool's advice, or none when it fails or is slow: a start never waits on it for long. */
  async function adviceFor(projectId: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ADVICE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([deps.node.advice(projectId), timeout]);
    } catch {
      deps.logger.warn('node advice failed', { projectId });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function runCommand(ctx: Ctx, settings: ScriptsSettings, project: DetectedProject, argv: string[]) {
    const use = venvUse(settings, project);
    const label = use.venv === null || project.python === null ? null : fromRoot(rootPathOf(project), use.venv);
    return commandRun(project, argv, ctx.platform, { ...use, label });
  }

  function pythonChoice(settings: ScriptsSettings, project: DetectedProject) {
    if (project.python === null) return null;
    const root = rootPathOf(project);
    const choice = settings.venvs.find((v) => v.relPath === project.relPath);
    const auto = autoVenv(project);
    const { venv } = venvUse(settings, project);
    return {
      choice: choice === undefined ? ('auto' as const) : choice.venv === null ? ('none' as const) : ('path' as const),
      venv: venv === null ? null : fromRoot(root, venv),
      auto: auto === null ? null : fromRoot(root, auto),
    };
  }

  /** The Node tool is asked only about package.json scripts. The env file is read at every spawn. */
  const requestFor = async (
    ctx: Ctx,
    settings: ScriptsSettings,
    project: DetectedProject,
    runnable: Runnable,
  ): Promise<StartRequest> => {
    const envFile = envFileOf(settings, project, runnable);
    return {
      projectId: project.id,
      script: runnable.name,
      cwd: project.path,
      packageManager: project.packageManager,
      autoRestart: isAuto(settings, project, runnable.name),
      ...(envFile === null ? {} : { loadEnv: { file: envFile, read: () => deps.envFiles.read(project.path, envFile) } }),
      ...(runnable.argv === null ? await adviceFor(project.id) : runCommand(ctx, settings, project, runnable.argv)),
    };
  };

  function requireRoot(project: DetectedProject): void {
    if (project.relPath !== '') throw new NestboxError('VALIDATION', 'Run groups belong to the root project');
  }

  function findGroup(project: DetectedProject, name: string): RunGroup {
    const group = deps.runGroups.get(project.rootId).find((g) => g.name === name);
    if (!group) throw new NestboxError('NOT_FOUND', 'Unknown run group');
    return group;
  }

  /** The package an entry names and what it runs, or null when either is gone. */
  function resolveEntry(
    rootId: string,
    settings: ScriptsSettings,
    entry: RunGroupEntry,
  ): { project: DetectedProject; runnable: Runnable } | null {
    const id = entry.relPath === '' ? rootId : workspaceId(rootId, entry.relPath);
    try {
      const project = deps.getDetected(id);
      const runnable = findRunnable(project, settings, entry.script);
      return runnable ? { project, runnable } : null;
    } catch {
      return null;
    }
  }

  /** The package a compose entry names, or null when it is gone or has no compose file. */
  function resolveCompose(rootId: string, entry: RunGroupCompose): DetectedProject | null {
    const id = entry.relPath === '' ? rootId : workspaceId(rootId, entry.relPath);
    try {
      const project = deps.getDetected(id);
      return project.dockerCompose === null ? null : project;
    } catch {
      return null;
    }
  }

  /** Brings a group's compose services up and waits for them; a failure never stops the scripts. */
  async function composeUp(rootId: string, entry: RunGroupCompose): Promise<ComposeStep> {
    const project = resolveCompose(rootId, entry);
    if (!project) return { relPath: entry.relPath, result: 'missing' };
    try {
      const { ok } = await deps.compose.up(project.id, entry.services, { wait: true });
      if (!ok) deps.logger.warn('run group compose failed', { projectId: project.id });
      return { relPath: entry.relPath, result: ok ? 'ok' : 'failed' };
    } catch (error) {
      const code = error instanceof NestboxError ? error.code : 'unknown';
      deps.logger.warn('run group compose failed', { projectId: project.id, code });
      return { relPath: entry.relPath, result: code === 'CONFLICT' ? 'busy' : code === 'NOT_FOUND' ? 'missing' : 'failed' };
    }
  }

  /**
   * Candidate files for a path taken from log text, most likely first: file: URLs, paths relative to
   * the project, and rooted paths, which Vite prints relative to the project but which are absolute on POSIX.
   */
  function candidatePaths(project: DetectedProject, raw: string): string[] {
    if (raw.startsWith('file:')) {
      try {
        return [fileURLToPath(raw)];
      } catch {
        return [];
      }
    }
    if (/^[\\/](?![\\/])/.test(raw)) return [resolve(project.path, `.${raw}`), resolve(raw)];
    return [isAbsolute(raw) ? raw : resolve(project.path, raw)];
  }

  return defineMainTool({
    ...scriptsDefinition,
    contract: scriptsContract,

    async dispose() {
      batcher.flushNow();
      batcher.dispose();
    },

    handlers: {
      list: async (ctx: Ctx) => {
        const settings = ctx.settings.get();
        const scripts = infosOf(settings, ctx.project)
          // The main one first.
          .sort((a, b) => Number(b.main) - Number(a.main));
        const envFiles = await envFilesOf(ctx.project);
        const hidden = hiddenOf(ctx.project, settings);
        const python = pythonChoice(settings, ctx.project);
        if (ctx.project.relPath !== '') {
          return { scripts, runGroups: null, packages: null, favorites: null, envFiles, hidden, python };
        }
        // Each package's main, the root's own first: what a root with packages lists.
        const favorites =
          ctx.project.workspaces.length === 0
            ? null
            : await Promise.all(
                [ctx.project, ...ctx.project.workspaces].flatMap((p) =>
                  infosOf(settings, p)
                    .filter((info) => info.main)
                    .map(async (info) => ({
                      ...info,
                      projectId: p.id,
                      relPath: p.relPath,
                      packageName: p.name,
                      envFiles: p.id === ctx.project.id ? envFiles : await envFilesOf(p),
                    })),
                ),
              );
        const packages = [ctx.project, ...ctx.project.workspaces].map((p) => {
          const names = runnables(p, settings).map((r) => r.name);
          const pkgMain = mainOf(settings, p);
          return {
            relPath: p.relPath,
            name: p.name,
            scripts: names,
            compose: p.dockerCompose !== null,
            main: pkgMain !== null && names.includes(pkgMain) ? pkgMain : null,
          };
        });
        return { scripts, runGroups: deps.runGroups.get(ctx.project.rootId), packages, favorites, envFiles, hidden, python };
      },

      start: async (ctx: Ctx, { script }) => {
        const settings = ctx.settings.get();
        const runnable = requireRunnable(ctx.project, settings, script);
        return deps.processes.start(await requestFor(ctx, settings, ctx.project, runnable));
      },

      stop: async (ctx: Ctx, { script }) => deps.processes.stop(ctx.project.id, script),

      restart: async (ctx: Ctx, { script }) => {
        const settings = ctx.settings.get();
        const runnable = requireRunnable(ctx.project, settings, script);
        return deps.processes.restart(await requestFor(ctx, settings, ctx.project, runnable));
      },

      setAutoRestart: async (ctx: Ctx, { script, enabled }) => {
        requireRunnable(ctx.project, ctx.settings.get(), script);
        const { relPath } = ctx.project;
        ctx.settings.update((s) => ({
          ...s,
          autoRestart: [
            ...s.autoRestart.filter((e) => !(e.relPath === relPath && e.script === script)),
            ...(enabled ? [{ relPath, script }] : []),
          ],
        }));
        deps.processes.setAutoRestart(ctx.project.id, script, enabled);
        return { enabled };
      },

      getLogs: async (ctx: Ctx, { script, afterSeq }) => deps.processes.logs(ctx.project.id, script, afterSeq),

      clearLogs: async (ctx: Ctx, { script }) => {
        deps.processes.clearLogs(ctx.project.id, script);
      },

      exportLogs: async (ctx: Ctx, { script, seqs }) => {
        const all = deps.processes.logs(ctx.project.id, script).lines;
        const wanted = seqs === 'all' ? null : new Set(seqs);
        const lines = wanted ? all.filter((l) => wanted.has(l.seq)) : all;
        const path = await deps.saveFile(exportFileName(script, new Date()));
        if (path === null) return { saved: false };
        await deps.writeFile(path, formatExport(lines));
        return { saved: true };
      },

      openFileAt: async (ctx: Ctx, { path, line }) => {
        for (const file of candidatePaths(ctx.project, path)) {
          if (await deps.isFile(file)) {
            await ctx.platform.openInEditor(file, line);
            return;
          }
        }
        throw new NestboxError('NOT_FOUND', 'File not found');
      },

      saveCommand: async (ctx: Ctx, { previousName, name, argv, main }) => {
        const { relPath, id, rootId } = ctx.project;
        const settings = ctx.settings.get();
        const isOld = (c: { relPath: string; name: string }) => c.relPath === relPath && c.name === previousName;
        if (previousName !== undefined && !settings.commands.some(isOld)) {
          throw new NestboxError('NOT_FOUND', 'Unknown command');
        }
        const others = runnables(ctx.project, { ...settings, commands: settings.commands.filter((c) => !isOld(c)) });
        if (others.some((r) => r.name === name)) {
          throw new NestboxError('CONFLICT', 'This package already has a script or command with this name');
        }
        if (previousName === undefined && settings.commands.length >= MAX_COMMANDS) {
          throw new NestboxError('VALIDATION', `A project can have at most ${MAX_COMMANDS} commands`);
        }
        const wasRenamed = previousName !== undefined && previousName !== name;
        if (wasRenamed && isRunning(id, previousName)) {
          throw new NestboxError('CONFLICT', 'Stop the command before renaming it');
        }
        const saved = { relPath, name, argv };
        ctx.settings.update((s) => {
          const rename = <T extends RunGroupEntry>(list: T[]): T[] =>
            wasRenamed && previousName !== undefined ? renamed(list, relPath, previousName, name) : list;
          let mains = rename(s.main);
          if (main === true) mains = [...mains.filter((e) => e.relPath !== relPath), { relPath, script: name }];
          if (main === false) mains = mains.filter((e) => !isEntry(relPath, name)(e));
          return {
            ...s,
            commands: previousName === undefined ? [...s.commands, saved] : s.commands.map((c) => (isOld(c) ? saved : c)),
            autoRestart: rename(s.autoRestart),
            envFiles: rename(s.envFiles),
            main: mains,
          };
        });
        if (wasRenamed) {
          const groups = deps.runGroups.get(rootId);
          const renameEntry = (e: RunGroupEntry): RunGroupEntry =>
            e.relPath === relPath && e.script === previousName ? { relPath, script: name } : e;
          if (groups.some((g) => g.entries.some((e) => renameEntry(e) !== e))) {
            deps.runGroups.set(rootId, groups.map((g) => ({ ...g, entries: g.entries.map(renameEntry) })));
          }
        }
      },

      deleteCommand: async (ctx: Ctx, { name }) => {
        const { relPath, id } = ctx.project;
        const isIt = (c: CustomCommand) => c.relPath === relPath && c.name === name;
        if (!ctx.settings.get().commands.some(isIt)) throw new NestboxError('NOT_FOUND', 'Unknown command');
        if (isRunning(id, name)) throw new NestboxError('CONFLICT', 'Stop the command before deleting it');
        const other = (e: RunGroupEntry) => !isEntry(relPath, name)(e);
        ctx.settings.update((s) => ({
          ...s,
          commands: s.commands.filter((c) => !isIt(c)),
          autoRestart: s.autoRestart.filter(other),
          envFiles: s.envFiles.filter(other),
          main: s.main.filter(other),
        }));
      },

      hideCommand: async (ctx: Ctx, { script }) => {
        const runnable = requireRunnable(ctx.project, ctx.settings.get(), script);
        if (runnable.kind !== 'detected') throw new NestboxError('NOT_FOUND', 'Only detected commands can be removed this way');
        if (isRunning(ctx.project.id, script)) throw new NestboxError('CONFLICT', 'Stop the command before removing it');
        const { relPath } = ctx.project;
        ctx.settings.update((s) => ({ ...s, hidden: [...s.hidden.filter((e) => !isEntry(relPath, script)(e)), { relPath, script }] }));
      },

      showCommand: async (ctx: Ctx, { script }) => {
        const { relPath } = ctx.project;
        if (!ctx.settings.get().hidden.some(isEntry(relPath, script))) throw new NestboxError('NOT_FOUND', 'Unknown command');
        ctx.settings.update((s) => ({ ...s, hidden: s.hidden.filter((e) => !isEntry(relPath, script)(e)) }));
      },

      pythonEnvs: async (ctx: Ctx) => ({ envs: await findProjectVenvs(rootPathOf(ctx.project)).catch(() => []) }),

      setVenv: async (ctx: Ctx, { mode, path }) => {
        if (ctx.project.python === null) throw new NestboxError('VALIDATION', 'Not a Python package');
        const { relPath } = ctx.project;
        let venv: string | null = null;
        if (mode === 'path') {
          if (path === undefined) throw new NestboxError('VALIDATION', 'Choose a virtualenv folder');
          const root = rootPathOf(ctx.project);
          const abs = resolveFromRoot(root, path.trim());
          if (!(await deps.isFile(join(abs, 'pyvenv.cfg')))) {
            throw new NestboxError('VALIDATION', 'Not a virtualenv: that folder has no pyvenv.cfg');
          }
          venv = fromRoot(root, abs);
        }
        ctx.settings.update((s) => ({
          ...s,
          venvs: [
            ...s.venvs.filter((v) => v.relPath !== relPath),
            ...(mode === 'auto' ? [] : [{ relPath, venv }]),
          ],
        }));
      },

      setEnvFile: async (ctx: Ctx, { script, file }) => {
        const runnable = requireRunnable(ctx.project, ctx.settings.get(), script);
        const { relPath } = ctx.project;
        ctx.settings.update((s) => ({
          ...s,
          envFiles: [
            ...s.envFiles.filter((e) => !isEntry(relPath, script)(e)),
            // Only a choice that differs from the default is kept.
            ...(file === defaultEnvFile(runnable) ? [] : [{ relPath, script, file }]),
          ],
        }));
      },

      setMain: async (ctx: Ctx, { script, main }) => {
        requireRunnable(ctx.project, ctx.settings.get(), script);
        const { relPath } = ctx.project;
        ctx.settings.update((s) => ({
          ...s,
          main: [
            ...s.main.filter((e) => (main ? e.relPath !== relPath : !isEntry(relPath, script)(e))),
            ...(main ? [{ relPath, script }] : []),
          ],
        }));
      },

      pythonFiles: async (ctx: Ctx) => ({
        files: ctx.project.python === null ? [] : await listPythonFiles(ctx.project.path),
      }),

      saveRunGroup: async (ctx: Ctx, { previousName, group }) => {
        requireRoot(ctx.project);
        const groups = deps.runGroups.get(ctx.project.rootId);
        const replacing = previousName ?? group.name;
        if (previousName !== undefined && !groups.some((g) => g.name === previousName)) {
          throw new NestboxError('NOT_FOUND', 'Unknown run group');
        }
        if (groups.some((g) => g.name === group.name && g.name !== replacing)) {
          throw new NestboxError('CONFLICT', 'A run group with this name already exists');
        }
        const exists = groups.some((g) => g.name === replacing);
        const next = exists ? groups.map((g) => (g.name === replacing ? group : g)) : [...groups, group];
        return deps.runGroups.set(ctx.project.rootId, next);
      },

      deleteRunGroup: async (ctx: Ctx, { name }) => {
        requireRoot(ctx.project);
        findGroup(ctx.project, name);
        return deps.runGroups.set(
          ctx.project.rootId,
          deps.runGroups.get(ctx.project.rootId).filter((g) => g.name !== name),
        );
      },

      startRunGroup: async (ctx: Ctx, { name }) => {
        const group = findGroup(ctx.project, name);
        // Services first, so a database is accepting connections before the API starts.
        const compose = await Promise.all(group.compose.map((entry) => composeUp(ctx.project.rootId, entry)));
        const settings = ctx.settings.get();
        const skipped: SkippedEntry[] = [];
        const started: ProcessSummary[] = [];
        const results = await Promise.allSettled(
          group.entries.map(async (entry) => {
            const resolved = resolveEntry(ctx.project.rootId, settings, entry);
            if (!resolved) {
              skipped.push({ ...entry, reason: 'missing' });
              return;
            }
            const { project, runnable } = resolved;
            try {
              started.push(
                await deps.processes.start(await requestFor(ctx, settings, project, runnable)),
              );
            } catch (error) {
              if (error instanceof NestboxError && error.code === 'CONFLICT') {
                skipped.push({ ...entry, reason: 'running' });
                return;
              }
              throw error;
            }
          }),
        );
        const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failure) throw failure.reason;
        return { started, skipped, compose };
      },

      stopRunGroup: async (ctx: Ctx, { name }) => {
        const group = findGroup(ctx.project, name);
        const ids = new Set(
          group.entries.map((e) => JSON.stringify([e.relPath === '' ? ctx.project.rootId : workspaceId(ctx.project.rootId, e.relPath), e.script])),
        );
        // Live members, and crashed ones waiting out an auto-restart backoff (or they would come back).
        const targets = deps.processes
          .list()
          .filter(
            (p) => (isLive(p.state) || p.nextRestartAt !== null) && ids.has(JSON.stringify([p.projectId, p.script])),
          );
        const services = group.compose.flatMap((entry) => {
          const project = resolveCompose(ctx.project.rootId, entry);
          return project ? [{ project, entry }] : [];
        });
        await Promise.allSettled([
          ...targets.map((p) => deps.processes.stop(p.projectId, p.script)),
          // `stop`, never `down`: containers and volumes stay.
          ...services.map(({ project, entry }) =>
            deps.compose.stop(project.id, entry.services).catch((error: unknown) => {
              deps.logger.warn('run group compose stop failed', {
                projectId: project.id,
                code: error instanceof NestboxError ? error.code : 'unknown',
              });
            }),
          ),
        ]);
      },
    },
  });
}
