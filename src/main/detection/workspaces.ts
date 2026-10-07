import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { glob } from 'tinyglobby';
import { parse as parseYaml } from 'yaml';
import { isRecord } from '@shared/is-record';
import { ECOSYSTEM_MODULES } from '../ecosystems';
import type { DetectOptions } from './detect-project';

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

async function pnpmPatterns(root: string, options: DetectOptions): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    return [];
  }
  try {
    const doc: unknown = parseYaml(text);
    return isRecord(doc) ? strings(doc['packages']) : [];
  } catch {
    options.onWarning?.('pnpm-workspace.yaml', 'invalid-yaml');
    return [];
  }
}

function packageJsonPatterns(pkg: Record<string, unknown> | null): string[] {
  if (!pkg) return [];
  const ws = pkg['workspaces'];
  if (Array.isArray(ws)) return strings(ws);
  if (isRecord(ws)) return strings(ws['packages']);
  return [];
}

function clean(pattern: string): string {
  return pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

/** tinyglobby accepts `../*` and absolute patterns; neither may leave the project root. */
function escapesRoot(pattern: string): boolean {
  return (
    isAbsolute(pattern) ||
    pattern.startsWith('/') ||
    pattern.startsWith('\\') ||
    /^[a-zA-Z]:/.test(pattern) ||
    pattern.split(/[\\/]/).includes('..')
  );
}

function insideRoot(root: string, dir: string): boolean {
  const rel = relative(resolve(root), resolve(root, dir));
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** Folders never taken as packages when looking for them without a workspaces config. */
const NOT_PACKAGES = [
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'tmp',
  'test',
  'tests',
  'e2e',
  'fixtures',
  '__fixtures__',
  'examples',
  'example',
];

/**
 * A folder like shop/ holding app/ and api/ (each with its own package.json) but no workspaces config:
 * its packages are the package.json folders one or two levels down, plus ecosystem packages.
 */
async function subFolderPackages(root: string): Promise<string[]> {
  const ignore = NOT_PACKAGES.flatMap((name) => [`${name}/**`, `*/${name}/**`]);

  // Node packages
  const nodePackages = await glob(['*/package.json', '*/*/package.json'], {
    cwd: root,
    ignore,
    onlyFiles: true,
    dot: false,
  });

  // Ecosystem packages (e.g. Python, .NET): the modules' globs match marker files, whose folders are packages.
  const ecosystemGlobs = ECOSYSTEM_MODULES.flatMap((m) => m.packageGlobs);
  const ecosystemManifests =
    ecosystemGlobs.length > 0
      ? await glob(ecosystemGlobs, { cwd: root, ignore, onlyFiles: true, dot: false })
      : [];
  // A marker inside a Node package (frontend/tools/pyproject.toml) belongs to that package.
  const posixDir = (manifest: string) => posix.dirname(manifest.replace(/\\/g, '/'));
  const nodeDirs = nodePackages.map(posixDir);
  const insideNode = (manifest: string) => nodeDirs.some((d) => posixDir(manifest).startsWith(`${d}/`));

  return [...nodePackages, ...ecosystemManifests.filter((m) => !insideNode(m))];
}

export async function findWorkspaceDirs(
  root: string,
  packageJson: Record<string, unknown> | null,
  options: DetectOptions = {},
): Promise<string[]> {
  const patterns = [...(await pnpmPatterns(root, options)), ...packageJsonPatterns(packageJson)];
  if (patterns.length === 0) return keepInside(root, await subFolderPackages(root), options);

  const include = patterns
    .filter((p) => !p.startsWith('!'))
    .map(clean)
    .filter((p) => p && p !== '.' && !escapesRoot(p));
  const exclude = patterns
    .filter((p) => p.startsWith('!'))
    .map((p) => clean(p.slice(1)))
    .filter((p) => !escapesRoot(p));
  if (include.length === 0) return [];

  const manifests = await glob(
    include.map((p) => `${p}/package.json`),
    {
      cwd: root,
      ignore: ['**/node_modules/**', ...exclude.map((p) => `${p}/package.json`)],
      onlyFiles: true,
    },
  );
  return keepInside(root, manifests, options);
}

/** Package folders from manifest paths: sorted, never the root, and only those really inside it. */
async function keepInside(
  root: string,
  manifests: string[],
  options: DetectOptions,
): Promise<string[]> {
  const dirs = new Set(manifests.map((file) => posix.dirname(file.replace(/\\/g, '/'))));
  dirs.delete('.');
  const realRoot = await realpath(root).catch(() => resolve(root));
  const kept: string[] = [];
  for (const dir of [...dirs].filter((d) => insideRoot(root, d)).sort()) {
    // A symlinked (or junctioned) folder can point anywhere: only keep it when its target is inside the root.
    const real = await realpath(join(root, ...dir.split('/'))).catch(() => null);
    if (real === null) continue;
    if (insideRoot(realRoot, real)) kept.push(dir);
    else options.onWarning?.(dir, 'outside-root');
  }
  return kept;
}
