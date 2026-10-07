import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NestboxError } from '@shared/errors';
import { renderWithProviders } from '@/test/render';
import { CommandDialog } from './CommandDialog';
import { installScriptsBridge } from './test-bridge';

function open(
  initial: { name: string; command: string; main?: boolean } | null = null,
  methods = {},
  pythonFiles: string[] = [],
) {
  const fx = installScriptsBridge({ methods, pythonFiles });
  const onOpenChange = vi.fn();
  renderWithProviders(
    <CommandDialog projectId="p1::backend" initial={initial} onOpenChange={onOpenChange} />,
  );
  return { ...fx, onOpenChange };
}

describe('CommandDialog', () => {
  it('saves a typed command line as a program and its arguments', async () => {
    const { callsTo, calls, onOpenChange } = open();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Name' }), 'api');
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Command' }),
      'uvicorn app.main:app --reload --port 8000',
    );
    expect(screen.getByText('uvicorn')).toBeInTheDocument();
    expect(screen.getByText(/with 4 arguments/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(callsTo('saveCommand')).toEqual([
        {
          name: 'api',
          argv: ['uvicorn', 'app.main:app', '--reload', '--port', '8000'],
          main: false,
        },
      ]),
    );
    expect(calls[0]?.projectId).toBe('p1::backend');
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('explains what cannot be saved', async () => {
    const { callsTo } = open();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Name' }), 'bad name');
    expect(screen.getByText(/Use letters, digits/)).toBeInTheDocument();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Name' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'api');
    await userEvent.type(screen.getByRole('textbox', { name: 'Command' }), 'PORT=1 python main.py');
    expect(
      screen.getByText('Put environment variables in .env, not in the command.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(callsTo('saveCommand')).toEqual([]);
  });

  it('edits an existing command, keeping its previous name', async () => {
    const { callsTo } = open({ name: 'seed', command: 'python seed.py' });
    const command = await screen.findByRole('textbox', { name: 'Command' });
    expect(command).toHaveValue('python seed.py');
    await userEvent.type(command, ' --count 5');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(callsTo('saveCommand')).toEqual([
        {
          previousName: 'seed',
          name: 'seed',
          argv: ['python', 'seed.py', '--count', '5'],
          main: false,
        },
      ]),
    );
  });

  it('stays open and toasts a clash', async () => {
    const { onOpenChange } = open(null, {
      saveCommand: () => {
        throw new NestboxError(
          'CONFLICT',
          'This package already has a script or command with this name',
        );
      },
    });
    await userEvent.type(await screen.findByRole('textbox', { name: 'Name' }), 'dev');
    await userEvent.type(screen.getByRole('textbox', { name: 'Command' }), 'python main.py');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('This package already has a script or command with this name'),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('fills the command from a Python file and saves it as the main command', async () => {
    const { callsTo } = open(null, {}, ['server.py', 'app/run server.py']);
    const picker = await screen.findByRole('combobox', { name: 'Python file' });
    await userEvent.selectOptions(picker, 'app/run server.py');
    expect(screen.getByRole('textbox', { name: 'Command' })).toHaveValue(
      'python "app/run server.py"',
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('run-server');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Main command of this package' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(callsTo('saveCommand')).toEqual([
        { name: 'run-server', argv: ['python', 'app/run server.py'], main: true },
      ]),
    );
  });

  it('offers no Python file picker without Python files, and keeps main when editing', async () => {
    const { callsTo } = open({ name: 'api', command: 'node api.js', main: true });
    expect(
      await screen.findByRole('checkbox', { name: 'Main command of this package' }),
    ).toBeChecked();
    expect(screen.queryByRole('combobox', { name: 'Python file' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(callsTo('saveCommand')).toEqual([
        { previousName: 'api', name: 'api', argv: ['node', 'api.js'], main: true },
      ]),
    );
  });
});
