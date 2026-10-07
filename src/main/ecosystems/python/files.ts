// The .py files a package could run, for "run a Python file". Names only; files are never opened.
import { glob } from 'tinyglobby';

const MAX_FILES = 300;

/** Never a script to start: virtualenvs, installed packages, caches, tests and migrations. */
const IGNORE = [
  '.venv/**',
  'venv/**',
  'env/**',
  '**/site-packages/**',
  '**/__pycache__/**',
  '**/node_modules/**',
  '**/migrations/**',
  'test/**',
  'tests/**',
  '**/test_*.py',
  '**/*_test.py',
  '**/conftest.py',
  '**/__init__.py',
  'setup.py',
];

/** Posix paths, three levels deep at most: top-level files first, then by path. */
export async function listPythonFiles(dir: string): Promise<string[]> {
  const files = await glob(['*.py', '*/*.py', '*/*/*.py'], {
    cwd: dir,
    ignore: IGNORE,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
  });
  const depth = (f: string) => f.split('/').length;
  return files
    .map((f) => f.replace(/\\/g, '/'))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, MAX_FILES);
}
