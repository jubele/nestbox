// Virtualenvs inside a project, for the Scripts tab's Python environment choice. Only pyvenv.cfg's
// location is used; nothing is read.
import { posix } from 'node:path';
import { glob } from 'tinyglobby';

/** Posix paths from the project folder to each virtualenv (a folder holding pyvenv.cfg), shallowest first. */
export async function findProjectVenvs(rootDir: string): Promise<string[]> {
  const found = await glob(['*/pyvenv.cfg', '*/*/pyvenv.cfg', '*/*/*/pyvenv.cfg'], {
    cwd: rootDir,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**', '**/.git/**'],
  });
  const depth = (p: string) => p.split('/').length;
  return found
    .map((f) => posix.dirname(f.replace(/\\/g, '/')))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}
