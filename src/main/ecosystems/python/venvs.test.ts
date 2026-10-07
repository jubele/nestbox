import { afterEach, describe, expect, it } from 'vitest';
import { makeTree, removeTree } from '../../detection/test-fixtures';
import { findProjectVenvs } from './venvs';

let dir = '';
afterEach(async () => removeTree(dir));

describe('findProjectVenvs', () => {
  it('lists every virtualenv in the project, three levels deep at most', async () => {
    dir = await makeTree({
      '.venv/pyvenv.cfg': '',
      'backend/venv/pyvenv.cfg': '',
      'services/api/.venv/pyvenv.cfg': '',
      'a/b/c/.venv/pyvenv.cfg': '',
      'frontend/node_modules/x/.venv/pyvenv.cfg': '',
      'backend/notavenv/README': '',
    });
    expect(await findProjectVenvs(dir)).toEqual(['.venv', 'backend/venv', 'services/api/.venv']);
  });
});
