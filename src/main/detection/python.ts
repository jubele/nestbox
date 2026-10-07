import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { COMMAND_NAME, type DetectedCommand, type PythonInfo } from '@shared/detected';
import { isFile } from './fs-utils';

/** Files that make a folder a Python package even without a single `.py` file at its top. */
export const PYTHON_DEFINITION_FILES = [
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'manage.py',
];

/** Where an app usually lives, most likely first. */
const ENTRY_FILES = ['main.py', 'app.py', 'server.py', 'api.py', 'asgi.py', 'wsgi.py', 'run.py'];
/** The same names inside an `app/` package (FastAPI's usual layout). */
const APP_DIR_ENTRY_FILES = ['main.py', 'app.py', 'server.py', 'api.py', 'asgi.py'];
const VENV_DIRS = ['.venv', 'venv', 'env'];
const READ_CAP = 64 * 1024;
const MAX_SCRIPTS = 20;

const IDENT = String.raw`[A-Za-z_][A-Za-z0-9_]*`;
/** A module-level `<var> = FastAPI(` (optionally annotated, optionally `fastapi.FastAPI`). */
const FASTAPI_APP = new RegExp(
  String.raw`^(${IDENT})[ \t]*(?::[^=\n]+)?=[ \t]*(?:fastapi\.)?FastAPI[ \t]*\(`,
  'm',
);
const FLASK_APP = new RegExp(
  String.raw`^(${IDENT})[ \t]*(?::[^=\n]+)?=[ \t]*(?:flask\.)?Flask[ \t]*\(`,
  'm',
);
const MAIN_GUARD = /^if[ \t]+__name__[ \t]*==[ \t]*(['"])__main__\1[ \t]*:/m;

export const isPythonFile = (name: string): boolean => name.endsWith('.py');

/** The first 64 KiB of a file as text, or null when it can't be read. Only matched, never kept. */
async function readHead(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(READ_CAP);
    const { bytesRead } = await handle.read(buffer, 0, READ_CAP, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function findVenv(dir: string, dirs: ReadonlySet<string>): Promise<string | null> {
  for (const name of VENV_DIRS) {
    if (dirs.has(name) && (await isFile(join(dir, name, 'pyvenv.cfg')))) return name;
  }
  return null;
}

/** The virtualenv folder directly in dir (`.venv`, `venv`, `env` holding a pyvenv.cfg), or null. */
export async function findVenvIn(dir: string): Promise<string | null> {
  return findVenv(dir, new Set(VENV_DIRS));
}

/** A FastAPI or Flask app defined at module level in one of the entry files. */
async function findApp(
  dir: string,
  files: ReadonlySet<string>,
  dirs: ReadonlySet<string>,
): Promise<Pick<PythonInfo, 'framework' | 'commands'> | null> {
  const candidates = [
    ...ENTRY_FILES.filter((f) => files.has(f)).map((f) => ({
      path: join(dir, f),
      module: f.slice(0, -3),
    })),
    ...(dirs.has('app')
      ? APP_DIR_ENTRY_FILES.map((f) => ({
          path: join(dir, 'app', f),
          module: `app.${f.slice(0, -3)}`,
        }))
      : []),
  ];
  for (const { path, module } of candidates) {
    const text = await readHead(path);
    if (text === null) continue;
    const fastapi = FASTAPI_APP.exec(text)?.[1];
    if (fastapi) {
      return {
        framework: 'fastapi',
        commands: [
          { name: 'dev', argv: ['python', '-m', 'uvicorn', `${module}:${fastapi}`, '--reload'] },
        ],
      };
    }
    const flask = FLASK_APP.exec(text)?.[1];
    if (flask) {
      const target = flask === 'app' ? module : `${module}:${flask}`;
      return {
        framework: 'flask',
        commands: [
          { name: 'dev', argv: ['python', '-m', 'flask', '--app', target, 'run', '--debug'] },
        ],
      };
    }
  }
  return null;
}

/** Top-level files with a `__main__` guard, entry files first, then by name. */
async function findScripts(dir: string, files: ReadonlySet<string>): Promise<DetectedCommand[]> {
  const rank = (f: string) =>
    ENTRY_FILES.includes(f) ? ENTRY_FILES.indexOf(f) : ENTRY_FILES.length;
  const names = [...files]
    .filter((f) => isPythonFile(f) && f !== 'setup.py' && COMMAND_NAME.test(f.slice(0, -3)))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, MAX_SCRIPTS);
  const commands: DetectedCommand[] = [];
  for (const file of names) {
    const text = await readHead(join(dir, file));
    if (text !== null && MAIN_GUARD.test(text))
      commands.push({ name: file.slice(0, -3), argv: ['python', file] });
  }
  return commands;
}

/**
 * Python facts for one folder: null without a definition file or a top-level `.py` file. Files are read
 * only to match an app or a `__main__` guard; their contents are never kept, logged or returned.
 */
export async function detectPython(
  dir: string,
  files: ReadonlySet<string>,
  dirs: ReadonlySet<string>,
): Promise<PythonInfo | null> {
  if (!PYTHON_DEFINITION_FILES.some((f) => files.has(f)) && ![...files].some(isPythonFile))
    return null;
  const venv = await findVenv(dir, dirs);
  if (files.has('manage.py')) {
    return {
      venv,
      framework: 'django',
      commands: [
        { name: 'runserver', argv: ['python', 'manage.py', 'runserver'] },
        { name: 'migrate', argv: ['python', 'manage.py', 'migrate'] },
      ],
    };
  }
  const app = await findApp(dir, files, dirs);
  if (app) return { venv, ...app };
  const scripts = await findScripts(dir, files);
  return { venv, framework: scripts.length > 0 ? 'script' : null, commands: scripts };
}
