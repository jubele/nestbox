import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTree, removeTree } from '../../detection/test-fixtures';
import { createDarwinAdapter } from '../../platform/darwin';
import { noopRunner } from '../../platform/testing';
import type { EcosystemChoices, RunEnvContext } from '../types';
import { type PythonInfo, pythonModule } from './index';

const detect = (files: string[], dirs: string[] = []) => pythonModule.detect('/dev/app', new Set(files), new Set(dirs));

const info = (over: Partial<PythonInfo> = {}): PythonInfo => ({
  venv: null,
  framework: null,
  entries: [],
  tests: false,
  ...over,
});

describe('python detect', () => {
  it('needs a definition file or a top-level .py file', async () => {
    expect(await detect(['package.json', 'README.md'], ['src'])).toBeNull();
    expect(await detect(['requirements.txt'])).toEqual(info());
    expect(await detect(['requirements-dev.txt'])).toEqual(info());
    expect(await detect(['pyproject.toml'])).toEqual(info());
    expect(await detect(['tool.py'])).toEqual(info());
  });

  it('finds Django, entry files, tests and a virtualenv folder by name only', async () => {
    expect(await detect(['manage.py', 'requirements.txt'], ['.venv', 'tests'])).toEqual(
      info({ venv: '.venv', framework: 'django', tests: true }),
    );
    expect(await detect(['app.py', 'main.py', 'helpers.py', 'conftest.py'], ['venv'])).toEqual(
      info({ venv: 'venv', entries: ['main.py', 'app.py'], tests: true }),
    );
  });
});

describe('python tasks', () => {
  it('offers Django commands, each entry file and pytest', () => {
    expect(pythonModule.tasks(info({ framework: 'django', entries: ['main.py'], tests: true }))).toEqual([
      { name: 'runserver', argv: ['python', 'manage.py', 'runserver'], title: 'Django development server' },
      { name: 'migrate', argv: ['python', 'manage.py', 'migrate'], title: 'Apply Django migrations' },
      { name: 'main', argv: ['python', 'main.py'], title: 'Run main.py' },
      { name: 'pytest', argv: ['python', '-m', 'pytest'], title: 'Run tests' },
    ]);
    expect(pythonModule.tasks(info())).toEqual([]);
  });
});

describe('python runEnv', () => {
  let dir = '';
  afterEach(async () => removeTree(dir));

  const platform = createDarwinAdapter({ runner: noopRunner, getEditorCommand: () => 'code' });
  const ctx = (pkg: string, settings: EcosystemChoices = {}): RunEnvContext<EcosystemChoices> => ({
    dir: join(dir, ...pkg.split('/')),
    rootDir: dir,
    platform,
    settings,
  });
  const unbuffered = { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };

  it("runs in the package's virtualenv, else the project folder's", async () => {
    dir = await makeTree({ 'backend/.venv/pyvenv.cfg': '', '.venv/pyvenv.cfg': '', 'worker/main.py': '' });
    expect(await pythonModule.runEnv(ctx('backend'), info({ venv: '.venv' }))).toEqual({
      env: { ...unbuffered, VIRTUAL_ENV: join(dir, 'backend', '.venv') },
      pathPrepend: join(dir, 'backend', '.venv', 'bin'),
      note: '▸ virtualenv: backend/.venv',
    });
    expect(await pythonModule.runEnv(ctx('worker'), info())).toMatchObject({
      env: { VIRTUAL_ENV: join(dir, '.venv') },
      note: '▸ virtualenv: .venv',
    });
  });

  it('ignores a folder named like a virtualenv without pyvenv.cfg, and uses python3 then', async () => {
    dir = await makeTree({ 'api/venv/README': '' });
    expect(await pythonModule.runEnv(ctx('api'), info({ venv: 'venv' }))).toEqual({
      env: unbuffered,
      programs: { python: 'python3' },
      note: '▸ No virtualenv (.venv) found: using python3 from PATH',
    });
  });

  it('follows the choice: a path from the project folder, an absolute one, or system Python', async () => {
    dir = await makeTree({ 'tools/env/pyvenv.cfg': '', 'api/.venv/pyvenv.cfg': '' });
    expect(await pythonModule.runEnv(ctx('api', { venv: 'tools/env' }), info({ venv: '.venv' }))).toMatchObject({
      env: { VIRTUAL_ENV: join(dir, 'tools', 'env') },
      note: '▸ virtualenv: tools/env',
    });
    const outside = resolve('/opt/envs/api');
    expect(await pythonModule.runEnv(ctx('api', { venv: outside }), info())).toMatchObject({
      env: { VIRTUAL_ENV: outside },
      note: `▸ virtualenv: ${outside}`,
    });
    expect(await pythonModule.runEnv(ctx('api', { venv: null }), info({ venv: '.venv' }))).toEqual({
      env: unbuffered,
      programs: { python: 'python3' },
      note: '▸ System Python chosen: using python3 from PATH',
    });
  });
});

describe('python files and summary', () => {
  let dir = '';
  afterEach(async () => removeTree(dir));

  it("offers the package's .py files as `python <file>`", async () => {
    dir = await makeTree({ 'server.py': '', 'app/main.py': '', 'tests/test_x.py': '' });
    expect(await pythonModule.files?.(dir, info())).toEqual([
      { path: 'server.py', argv: ['python', 'server.py'] },
      { path: 'app/main.py', argv: ['python', 'app/main.py'] },
    ]);
  });

  it('summarises the framework and the virtualenv folder', () => {
    expect(pythonModule.summary?.(info())).toBe('Python');
    expect(pythonModule.summary?.(info({ framework: 'django', venv: '.venv' }))).toBe('Python · Django · .venv');
  });
});
