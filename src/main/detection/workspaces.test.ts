import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTree, removeTree } from './test-fixtures';
import { findWorkspaceDirs } from './workspaces';

let dir = '';
afterEach(async () => removeTree(dir));

const PKG = '{"name":"x"}';

describe('findWorkspaceDirs', () => {
  it('returns [] when no workspaces are declared and no sub-folder has a package.json', async () => {
    dir = await makeTree({ 'package.json': PKG, 'src/index.ts': '' });
    expect(await findWorkspaceDirs(dir, {})).toEqual([]);
  });

  it('finds sub-folder packages up to two levels down when no workspaces are declared', async () => {
    dir = await makeTree({
      'app/package.json': PKG,
      'api/package.json': PKG,
      'services/billing/package.json': PKG,
      'too/deep/here/package.json': PKG,
      'app/node_modules/dep/package.json': PKG,
      '.cache/x/package.json': PKG,
      'dist/package.json': PKG,
      'test/fixtures/package.json': PKG,
      'e2e/package.json': PKG,
    });
    expect(await findWorkspaceDirs(dir, null)).toEqual(['api', 'app', 'services/billing']);
  });

  it('finds ecosystem packages next to Node ones from the modules\' globs (Python, .NET)', async () => {
    dir = await makeTree({
      'frontend/package.json': PKG,
      'backend/requirements.txt': '',
      'backend/main.py': '',
      'services/billing/pyproject.toml': '',
      'worker/main.py': '',
      'Api/Api.csproj': '',
      'scripts/release.py': '',
      'frontend/tools/pyproject.toml': '',
    });
    // scripts/release.py isn't an entry file; frontend/tools sits inside another package.
    expect(await findWorkspaceDirs(dir, null)).toEqual(['Api', 'backend', 'frontend', 'services/billing', 'worker']);
  });

  it('does not add sub-folders when workspaces are declared', async () => {
    dir = await makeTree({ 'packages/a/package.json': PKG, 'tools/b/package.json': PKG });
    expect(await findWorkspaceDirs(dir, { workspaces: ['packages/*'] })).toEqual(['packages/a']);
  });

  it('reads pnpm-workspace.yaml globs and negations', async () => {
    dir = await makeTree({
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'apps/*'\n  - '!packages/ignored'\n",
      'packages/api/package.json': PKG,
      'packages/ignored/package.json': PKG,
      'packages/no-manifest/README.md': 'x',
      'apps/web/package.json': PKG,
    });
    expect(await findWorkspaceDirs(dir, {})).toEqual(['apps/web', 'packages/api']);
  });

  it('reads package.json workspaces as an array or { packages }', async () => {
    dir = await makeTree({ 'packages/a/package.json': PKG, 'packages/b/package.json': PKG });
    expect(await findWorkspaceDirs(dir, { workspaces: ['packages/*'] })).toEqual([
      'packages/a',
      'packages/b',
    ]);
    expect(await findWorkspaceDirs(dir, { workspaces: { packages: ['packages/a'] } })).toEqual([
      'packages/a',
    ]);
  });

  it('never returns node_modules packages, duplicates or the root', async () => {
    dir = await makeTree({
      'package.json': PKG,
      'packages/a/package.json': PKG,
      'packages/a/node_modules/dep/package.json': PKG,
      'node_modules/other/package.json': PKG,
    });
    const result = await findWorkspaceDirs(dir, {
      workspaces: ['packages/**', 'packages/*', './packages/a/', '.'],
    });
    expect(result).toEqual(['packages/a']);
  });

  it('survives invalid YAML and warns with the file name only', async () => {
    dir = await makeTree({ 'pnpm-workspace.yaml': 'packages: [\n  - SECRET' });
    const onWarning = vi.fn();
    expect(await findWorkspaceDirs(dir, null, { onWarning })).toEqual([]);
    expect(onWarning).toHaveBeenCalledWith('pnpm-workspace.yaml', 'invalid-yaml');
    expect(JSON.stringify(onWarning.mock.calls)).not.toContain('SECRET');
  });

  it('ignores non-string patterns', async () => {
    dir = await makeTree({ 'packages/a/package.json': PKG });
    expect(await findWorkspaceDirs(dir, { workspaces: ['packages/*', 42, null] })).toEqual([
      'packages/a',
    ]);
  });

  it('ignores patterns that escape the project root', async () => {
    dir = await makeTree({
      'proj/pnpm-workspace.yaml': "packages:\n  - '../*'\n  - '/abs/*'\n  - 'packages/*'\n",
      'proj/packages/a/package.json': PKG,
      'sibling/package.json': PKG,
    });
    expect(await findWorkspaceDirs(join(dir, 'proj'), {})).toEqual(['packages/a']);
  });

  it('skips a symlinked package that resolves outside the root, with a warning', async (ctx) => {
    const outside = await makeTree({ 'package.json': PKG });
    try {
      dir = await makeTree({
        'package.json': PKG,
        'packages/api/package.json': PKG,
        packages: null,
      });
      try {
        // 'junction' makes a directory link without a privilege on Windows; it is ignored elsewhere.
        await symlink(outside, join(dir, 'packages', 'linked'), 'junction');
      } catch {
        ctx.skip();
      }
      const onWarning = vi.fn();
      expect(await findWorkspaceDirs(dir, { workspaces: ['packages/*'] }, { onWarning })).toEqual([
        'packages/api',
      ]);
      expect(onWarning).toHaveBeenCalledWith('packages/linked', 'outside-root');
    } finally {
      await removeTree(outside);
    }
  });

  it('keeps a symlinked package that resolves inside the root', async (ctx) => {
    dir = await makeTree({ 'package.json': PKG, 'libs/real/package.json': PKG, packages: null });
    try {
      await symlink(join(dir, 'libs', 'real'), join(dir, 'packages', 'alias'), 'junction');
    } catch {
      ctx.skip();
    }
    expect(await findWorkspaceDirs(dir, { workspaces: ['packages/*'] })).toEqual([
      'packages/alias',
    ]);
  });
});
