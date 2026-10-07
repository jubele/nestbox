import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { NestboxError } from '@shared/errors';
import type { EnvMatrix } from '@shared/tools/env/contract';
import { installMockBridge } from '@/test/mock-bridge';
import { renderWithProviders } from '@/test/render';
import EnvPanel from './Panel';

const SECRET = 'postgres://u:s3cr3t@h/db';

const MATRIX: EnvMatrix = {
  files: [
    { name: '.env.example', version: 'v-ex', readOnly: false, entries: 3, duplicates: [] },
    { name: '.env', version: 'v-env', readOnly: false, entries: 2, duplicates: [] },
    { name: '.env.staging', version: 'v-st', readOnly: true, entries: 1, duplicates: [] },
  ],
  keys: [
    { key: 'PORT', cells: { '.env.example': 'empty', '.env': 'set', '.env.staging': 'set' }, missing: false, undocumented: false },
    { key: 'DATABASE_URL', cells: { '.env.example': 'empty', '.env': 'set', '.env.staging': 'absent' }, missing: false, undocumented: false },
    { key: 'REDIS_URL', cells: { '.env.example': 'set', '.env': 'absent', '.env.staging': 'absent' }, missing: true, undocumented: false },
  ],
  example: '.env.example',
  profiles: [{ name: 'staging', file: '.env.staging', active: false }],
};

type Call = { method: string; input: Record<string, unknown> };

function setup(over: Partial<Record<string, (input: Record<string, unknown>) => unknown>> = {}, matrix: EnvMatrix = MATRIX) {
  const calls: Call[] = [];
  const bridge = installMockBridge({
    'tools:invoke': (({ method, input }: Call) => {
      calls.push({ method, input });
      const handler = over[method];
      if (handler) return handler(input);
      if (method === 'matrix') return matrix;
      if (method === 'reveal') return { value: input['key'] === 'DATABASE_URL' ? SECRET : 'redis://localhost:6379' };
      if (method === 'copy') return {};
      if (['setValue', 'addKey', 'removeKey'].includes(method)) return { version: 'v2' };
      if (method === 'switchProfile') return {};
      if (method === 'codeKeys') return { keys: [], files: 0, truncated: false };
      if (method === 'createFile') return { version: 'v1' };
      if (method === 'readRaw') return { text: `# local\nPORT=3000\nDATABASE_URL=${SECRET}\n`, version: 'raw-v1' };
      if (method === 'writeRaw') return { version: 'raw-v2' };
      throw new Error(`unexpected ${method}`);
    }) as never,
  });
  renderWithProviders(<EnvPanel projectId="p1" />);
  return { bridge, calls, of: (m: string) => calls.filter((c) => c.method === m).map((c) => c.input) };
}

const table = () => screen.findByRole('table', { name: 'Env files' });

describe('EnvPanel', () => {
  it('shows keys by file with values masked, the example first and flags', async () => {
    setup();
    const t = await table();
    expect(within(t).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Key', '.env.example', '.env', '.env.staging']);
    const row = within(t).getByRole('row', { name: /DATABASE_URL/ });
    expect(within(row).getAllByText('••••••')).toHaveLength(1);
    expect(within(t).getByRole('row', { name: /REDIS_URL/ })).toHaveTextContent('missing in .env');
    expect(t.textContent).not.toContain('s3cr3t');
  });

  it('reveals one value until the cell loses focus', async () => {
    setup();
    await table();
    await userEvent.click(screen.getByRole('button', { name: 'Reveal DATABASE_URL in .env' }));
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('heading', { name: 'Env files' }));
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull());
  });

  it('copies without revealing', async () => {
    const { of } = setup();
    await table();
    await userEvent.click(screen.getByRole('button', { name: 'Copy DATABASE_URL from .env' }));
    await waitFor(() => expect(of('copy')).toEqual([{ file: '.env', key: 'DATABASE_URL' }]));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('s3cr3t');
  });

  it('edits a value with the version it was based on', async () => {
    const { of } = setup();
    await table();
    await userEvent.click(screen.getByRole('button', { name: 'Edit PORT in .env' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit PORT in .env' });
    const input = await within(dialog).findByRole('textbox', { name: 'Value' });
    await waitFor(() => expect(input).toHaveValue('redis://localhost:6379'));
    await userEvent.clear(input);
    await userEvent.type(input, '4000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(of('setValue')).toEqual([{ file: '.env', key: 'PORT', value: '4000', version: 'v-env' }]));
  });

  it('closes the edit dialog when the current value cannot be loaded, so nothing is overwritten', async () => {
    const { of } = setup({
      reveal: () => {
        throw new NestboxError('NOT_FOUND', 'That key is not in this file');
      },
    });
    await table();
    await userEvent.click(screen.getByRole('button', { name: 'Edit PORT in .env' }));
    expect(await screen.findByText('That key is not in this file')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(of('setValue')).toEqual([]);
  });

  it('says so when the file changed on disk', async () => {
    setup({
      setValue: () => {
        throw new NestboxError('CONFLICT', 'The file changed on disk. Reload and try again.');
      },
    });
    await table();
    await userEvent.click(screen.getByRole('button', { name: 'Edit PORT in .env' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The file changed on disk. It has been reloaded.')).toBeInTheDocument();
  });

  it('adds a missing key, copying the value from the example', async () => {
    const { of } = setup();
    await table();
    await userEvent.click(screen.getByRole('button', { name: 'Add REDIS_URL to .env' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add REDIS_URL to .env' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Copy from .env.example' }));
    await waitFor(() => expect(within(dialog).getByRole('textbox', { name: 'Value' })).toHaveValue('redis://localhost:6379'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(of('addKey')).toEqual([{ file: '.env', key: 'REDIS_URL', value: 'redis://localhost:6379', version: 'v-env' }]),
    );
  });

  it('removes a key after a confirm', async () => {
    const { of } = setup();
    await table();
    await userEvent.click(screen.getByRole('button', { name: 'Remove DATABASE_URL from .env' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Remove DATABASE_URL from .env?');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(of('removeKey')).toEqual([{ file: '.env', key: 'DATABASE_URL', version: 'v-env' }]));
  });

  it('offers no edits for a read-only (symlinked) file', async () => {
    setup();
    await table();
    expect(screen.queryByRole('button', { name: 'Edit PORT in .env.staging' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reveal PORT in .env.staging' })).toBeInTheDocument();
  });

  it('filters to flagged keys', async () => {
    setup();
    const t = await table();
    await userEvent.click(screen.getByRole('switch', { name: 'Flagged only' }));
    await waitFor(() => expect(within(t).getAllByRole('row')).toHaveLength(2));
    expect(t).toHaveTextContent('REDIS_URL');
  });

  it('switches profile after a confirm that warns about an unsaved .env', async () => {
    const { of } = setup();
    await table();
    await userEvent.click(screen.getByRole('button', { name: 'Switch to staging' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Your current .env matches no profile. It will be kept only as .env.backup.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Switch' }));
    await waitFor(() => expect(of('switchProfile')).toEqual([{ file: '.env.staging', envVersion: 'v-env' }]));
  });

  it('offers no profile switch when .env is read-only', async () => {
    setup({}, { ...MATRIX, files: MATRIX.files.map((f) => (f.name === '.env' ? { ...f, readOnly: true } : f)) });
    await table();
    expect(screen.queryByRole('button', { name: 'Switch to staging' })).toBeNull();
  });

  it('reloads when the tool reports a change', async () => {
    const { bridge, of } = setup();
    await table();
    act(() => bridge.emit('tools:event', { toolId: 'env', projectId: 'p1', event: 'changed', payload: undefined }));
    await waitFor(() => expect(of('matrix')).toHaveLength(2));
  });

  it('says when there are no env files', async () => {
    setup({}, { files: [], keys: [], example: null, profiles: [] });
    expect(await screen.findByText('No .env files in this folder.')).toBeInTheDocument();
  });

  describe('keys from code', () => {
    const codeKeys = () => ({
      keys: [
        { key: 'PORT', files: 2 },
        { key: 'SENTRY_DSN', files: 1 },
      ],
      files: 3,
      truncated: false,
    });

    it('marks keys the code reads and adds rows for ones no file has', async () => {
      setup({ codeKeys });
      const t = await table();
      const port = await within(t).findByRole('row', { name: /PORT/ });
      expect(within(port).getByTitle('Read in 2 files')).toHaveTextContent('in code');
      const sentry = within(t).getByRole('row', { name: /SENTRY_DSN/ });
      expect(sentry).toHaveTextContent('not set');
      expect(within(sentry).getByRole('button', { name: 'Add SENTRY_DSN to .env' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('switch', { name: 'Flagged only' }));
      await waitFor(() => expect(within(t).getAllByRole('row')).toHaveLength(3));
      expect(t).toHaveTextContent('SENTRY_DSN');
    });

    it('creates .env with the keys from code when there is none', async () => {
      const { of } = setup({ codeKeys }, { files: [], keys: [], example: null, profiles: [] });
      expect(await screen.findByText('The code reads 2 variables: PORT, SENTRY_DSN.')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Create .env with these keys' }));
      await waitFor(() => expect(of('createFile')).toEqual([{ file: '.env', keys: ['PORT', 'SENTRY_DSN'] }]));
    });
  });

  describe('Add variable', () => {
    it('adds a new key to the chosen file', async () => {
      const { of } = setup();
      await table();
      await userEvent.click(screen.getByRole('button', { name: 'Add variable' }));
      const dialog = await screen.findByRole('dialog', { name: 'Add variable' });
      expect(within(dialog).getByRole('combobox', { name: 'File' })).toHaveValue('.env');
      await userEvent.type(within(dialog).getByRole('combobox', { name: 'Key' }), 'NEW_KEY');
      await userEvent.type(within(dialog).getByRole('textbox', { name: 'Value' }), 'abc');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(of('addKey')).toEqual([{ file: '.env', key: 'NEW_KEY', value: 'abc', version: 'v-env' }]));
    });

    it('refuses a key the file already has, or an invalid one', async () => {
      setup();
      await table();
      await userEvent.click(screen.getByRole('button', { name: 'Add variable' }));
      const dialog = await screen.findByRole('dialog', { name: 'Add variable' });
      await userEvent.type(within(dialog).getByRole('combobox', { name: 'Key' }), 'PORT');
      expect(within(dialog).getByText('.env already has PORT: edit it in the table.')).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
      await userEvent.clear(within(dialog).getByRole('combobox', { name: 'Key' }));
      await userEvent.type(within(dialog).getByRole('combobox', { name: 'Key' }), '1BAD');
      expect(within(dialog).getByText(/Letters, digits/)).toBeInTheDocument();
    });

    it('creates .env when the package has no env file', async () => {
      const { of } = setup({}, { files: [], keys: [], example: null, profiles: [] });
      await userEvent.click(await screen.findByRole('button', { name: 'Add variable' }));
      const dialog = await screen.findByRole('dialog', { name: 'Add variable' });
      expect(within(dialog).getByRole('option', { name: '.env (new file)' })).toBeInTheDocument();
      await userEvent.type(within(dialog).getByRole('combobox', { name: 'Key' }), 'DEBUG');
      await userEvent.type(within(dialog).getByRole('textbox', { name: 'Value' }), '1');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(of('addKey')).toEqual([{ file: '.env', key: 'DEBUG', value: '1', version: null }]));
    });
  });

  describe('raw editor', () => {
    it('edits a whole file as text with the version it was read at', async () => {
      const { of } = setup();
      await table();
      await userEvent.click(screen.getByRole('button', { name: 'Edit as text' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: '.env' }));
      const dialog = await screen.findByRole('dialog', { name: 'Edit .env' });
      const text = within(dialog).getByRole('textbox', { name: 'File contents' });
      await waitFor(() => expect(text).toHaveValue(`# local\nPORT=3000\nDATABASE_URL=${SECRET}\n`));
      await userEvent.type(text, 'DEBUG=1');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(of('writeRaw')).toEqual([
          { file: '.env', text: `# local\nPORT=3000\nDATABASE_URL=${SECRET}\nDEBUG=1`, version: 'raw-v1' },
        ]),
      );
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit .env' })).toBeNull());
    });

    it('keeps the edits when the file changed on disk, and reloads on request', async () => {
      const { of } = setup({
        writeRaw: () => {
          throw new NestboxError('CONFLICT', 'The file changed on disk. Reload and try again.');
        },
      });
      await table();
      await userEvent.click(screen.getByRole('button', { name: 'Edit as text' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: '.env' }));
      const dialog = await screen.findByRole('dialog', { name: 'Edit .env' });
      const text = within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: 'File contents' });
      await waitFor(() => expect(text.value).toContain('PORT=3000'));
      await userEvent.type(text, 'X=1');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByText(/changed on disk since you opened it/)).toBeInTheDocument();
      expect(text.value).toContain('X=1');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
      await waitFor(() => expect(of('readRaw')).toHaveLength(2));
      await waitFor(() => expect(text.value).not.toContain('X=1'));
    });

    it('opens the only env file straight away, and is not offered without one', async () => {
      setup({}, { ...MATRIX, files: MATRIX.files.filter((f) => f.name === '.env'), profiles: [] });
      await table();
      expect(screen.queryByRole('button', { name: 'Edit .env as text' })).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Edit as text' }));
      expect(await screen.findByRole('dialog', { name: 'Edit .env' })).toBeInTheDocument();
    });

    it('has no Edit as text button when there is no env file', async () => {
      setup({}, { files: [], keys: [], example: null, profiles: [] });
      await screen.findByText('No .env files in this folder.');
      expect(screen.queryByRole('button', { name: 'Edit as text' })).toBeNull();
    });

    it('only shows a read-only (symlinked) file', async () => {
      setup();
      await table();
      await userEvent.click(screen.getByRole('button', { name: 'Edit as text' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: '.env.staging (view only)' }));
      const dialog = await screen.findByRole('dialog', { name: '.env.staging' });
      expect(within(dialog).getByRole('textbox', { name: 'File contents' })).toHaveAttribute('readonly');
      expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
    });
  });
});
