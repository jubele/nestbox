import { afterEach, describe, expect, it } from 'vitest';
import { makeTree, removeTree } from '../../detection/test-fixtures';
import { listPythonFiles } from './files';

let dir = '';
afterEach(async () => removeTree(dir));

describe('listPythonFiles', () => {
  it('lists runnable .py files, top-level first, skipping tests, migrations and virtualenvs', async () => {
    dir = await makeTree({
      'server.py': '',
      'app/main.py': '',
      'app/__init__.py': '',
      'app/api/routes.py': '',
      'app/api/deep/too_deep.py': '',
      'app/migrations/0001.py': '',
      'tests/test_api.py': '',
      'app/test_util.py': '',
      'conftest.py': '',
      'setup.py': '',
      '.venv/lib/site.py': '',
      'venv/x.py': '',
      'app/__pycache__/m.py': '',
      'README.md': '',
    });
    expect(await listPythonFiles(dir)).toEqual(['server.py', 'app/main.py', 'app/api/routes.py']);
  });
});
