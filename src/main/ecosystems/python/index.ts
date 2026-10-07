import { access } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { DetectedTask, EcosystemChoices, EcosystemModule, RunEnv, RunEnvContext } from '../types';
import { listPythonFiles } from './files';

/** Files that make a folder a Python package even without a `.py` file at its top. */
export const PYTHON_DEFINITION_FILES = ['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'manage.py'];
/** requirements.txt, requirements-dev.txt, requirements.prod.txt, … */
const REQUIREMENTS = /^requirements[\w.-]*\.txt$/;
/** Files an app is usually started from, most likely first: each becomes `python <file>`. */
const ENTRY_FILES = ['main.py', 'app.py', 'server.py', 'api.py', 'run.py'];
const VENV_DIRS = ['.venv', 'venv', 'env'];

const PythonInfoSchema = z.object({
  /** A folder named like a virtualenv (`.venv`, `venv`, `env`); runEnv checks that it holds pyvenv.cfg. */
  venv: z.string().nullable(),
  framework: z.enum(['django']).nullable(),
  /** Entry files at the top of the package, in ENTRY_FILES order. */
  entries: z.array(z.string()),
  /** A `tests/` folder, `conftest.py` or `pytest.ini`. */
  tests: z.boolean(),
});
export type PythonInfo = z.infer<typeof PythonInfoSchema>;

const isPythonFile = (name: string): boolean => name.endsWith('.py');

async function isVenv(dir: string): Promise<boolean> {
  return access(join(dir, 'pyvenv.cfg')).then(
    () => true,
    () => false,
  );
}

/** The first virtualenv folder directly in dir (holding pyvenv.cfg), or null. */
async function venvIn(dir: string, names: readonly string[]): Promise<string | null> {
  for (const name of names) {
    if (await isVenv(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** A path for the log: posix from the project folder when inside it, else absolute as is. */
function label(rootDir: string, abs: string): string {
  const rel = relative(rootDir, abs);
  if (rel === '') return '.';
  return rel.startsWith('..') || isAbsolute(rel) ? abs : rel.split(sep).join('/');
}

/** The virtualenv in use (absolute) or null, and whether the user chose it (also the Scripts tab's environment choice). */
export async function resolveVenv(
  ctx: RunEnvContext<EcosystemChoices>,
  info: PythonInfo,
): Promise<{ venv: string | null; chosen: boolean }> {
  const choice = ctx.settings.venv;
  if (choice === null) return { venv: null, chosen: true };
  if (typeof choice === 'string') {
    return { venv: isAbsolute(choice) ? choice : join(ctx.rootDir, ...choice.split('/')), chosen: true };
  }
  // A package without its own uses the project folder's (frontend/ + backend/ sharing one .venv at the top).
  const own = info.venv === null ? null : await venvIn(ctx.dir, [info.venv]);
  const shared = own ?? (ctx.rootDir === ctx.dir ? null : await venvIn(ctx.rootDir, VENV_DIRS));
  return { venv: shared, chosen: false };
}

/**
 * Python packages: a definition file (pyproject.toml, requirements*.txt, Pipfile, setup.py/cfg, manage.py)
 * or a top-level `.py` file. Detection uses names only; runEnv picks the virtualenv.
 */
export const pythonModule: EcosystemModule<PythonInfo, EcosystemChoices> = {
  id: 'python',
  infoSchema: PythonInfoSchema,

  async detect(_dir, files, dirs) {
    const names = [...files];
    const defined = PYTHON_DEFINITION_FILES.some((f) => files.has(f)) || names.some((f) => REQUIREMENTS.test(f));
    if (!defined && !names.some(isPythonFile)) return null;
    return {
      venv: VENV_DIRS.find((d) => dirs.has(d)) ?? null,
      framework: files.has('manage.py') ? 'django' : null,
      entries: ENTRY_FILES.filter((f) => files.has(f)),
      tests: dirs.has('tests') || files.has('conftest.py') || files.has('pytest.ini'),
    };
  },

  // Sub-folders (one or two levels down) with a definition file, or an entry file one level down.
  packageGlobs: [
    ...[...PYTHON_DEFINITION_FILES, 'requirements*.txt'].flatMap((f) => [`*/${f}`, `*/*/${f}`]),
    ...ENTRY_FILES.map((f) => `*/${f}`),
  ],

  tasks(info) {
    const tasks: DetectedTask[] = [];
    if (info.framework === 'django') {
      tasks.push(
        { name: 'runserver', argv: ['python', 'manage.py', 'runserver'], title: 'Django development server' },
        { name: 'migrate', argv: ['python', 'manage.py', 'migrate'], title: 'Apply Django migrations' },
      );
    }
    for (const file of info.entries) {
      tasks.push({ name: file.slice(0, -'.py'.length), argv: ['python', file], title: `Run ${file}` });
    }
    if (info.tests) tasks.push({ name: 'pytest', argv: ['python', '-m', 'pytest'], title: 'Run tests' });
    return tasks;
  },

  async runEnv(ctx, info): Promise<RunEnv> {
    const env = { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
    const { venv, chosen } = await resolveVenv(ctx, info);
    if (venv !== null) {
      return {
        env: { ...env, VIRTUAL_ENV: venv },
        pathPrepend: ctx.platform.venvBinDir(venv),
        note: `▸ virtualenv: ${label(ctx.rootDir, venv)}`,
      };
    }
    // macOS has only python3.
    const python = ctx.platform.pythonCommand;
    return {
      env,
      programs: { python },
      note: chosen
        ? `▸ System Python chosen: using ${python} from PATH`
        : `▸ No virtualenv (.venv) found: using ${python} from PATH`,
    };
  },

  summary(info) {
    return ['Python', ...(info.framework === 'django' ? ['Django'] : []), ...(info.venv ? [info.venv] : [])].join(' · ');
  },

  async files(dir) {
    return (await listPythonFiles(dir)).map((path) => ({ path, argv: ['python', path] }));
  },
};
