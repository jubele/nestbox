import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { NestboxError } from '@shared/errors';
import { useUiStore } from '@/state/ui-store';
import { makeProcess } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { ScriptList } from './ScriptList';
import { installScriptsBridge } from './test-bridge';

const scripts = [
  { name: 'dev', command: 'vite', autoRestart: false, kind: 'npm' as const, envFile: null, main: false },
  { name: 'api', command: 'nest start --watch', autoRestart: true, kind: 'npm' as const, envFile: null, main: false },
];

describe('ScriptList', () => {
  it('lists scripts with their commands and a Start button when idle', async () => {
    installScriptsBridge({ scripts });
    renderWithProviders(<ScriptList projectId="p1" />);
    expect(await screen.findByText('nest start --watch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start dev' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop dev' })).toBeNull();
  });

  it('starts a script and shows it in the active pane', async () => {
    const { callsTo } = installScriptsBridge({ scripts });
    renderWithProviders(<ScriptList projectId="p1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start dev' }));
    await waitFor(() => expect(callsTo('start')).toEqual([{ script: 'dev' }]));
    expect(useUiStore.getState().scriptPanes['p1']?.scripts).toEqual(['dev']);
  });

  it('offers Stop and Restart while live, with a starting badge', async () => {
    const { callsTo } = installScriptsBridge({ scripts, processes: [makeProcess({ script: 'dev', state: 'starting' })] });
    renderWithProviders(<ScriptList projectId="p1" />);
    expect(await screen.findByText('starting')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restart dev' }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop dev' }));
    await waitFor(() => expect(callsTo('stop')).toEqual([{ script: 'dev' }]));
    expect(callsTo('restart')).toEqual([{ script: 'dev' }]);
  });

  it('shows a crash with its exit code, last line and count', async () => {
    installScriptsBridge({
      scripts,
      processes: [
        makeProcess({ script: 'dev', state: 'crashed', crashCount: 3, exit: { code: 1, signal: null, lastLine: 'Error: boom' } }),
      ],
    });
    renderWithProviders(<ScriptList projectId="p1" />);
    expect(await screen.findByText('exit 1 · Error: boom')).toBeInTheDocument();
    expect(screen.getByText('3 crashes')).toBeInTheDocument();
  });

  it('shows auto-restart progress and giving up', async () => {
    installScriptsBridge({
      scripts,
      processes: [
        makeProcess({ script: 'dev', state: 'crashed', crashCount: 1, nextRestartAt: 5, exit: { code: 1, signal: null, lastLine: null } }),
        makeProcess({ script: 'api', state: 'crashed', crashCount: 5, gaveUp: true, exit: { code: 1, signal: null, lastLine: null } }),
      ],
    });
    renderWithProviders(<ScriptList projectId="p1" />);
    expect(await screen.findByText('restarting…')).toBeInTheDocument();
    expect(screen.getByText('gave up after 5 crashes')).toBeInTheDocument();
  });

  it('toggles auto-restart', async () => {
    const { callsTo } = installScriptsBridge({ scripts });
    renderWithProviders(<ScriptList projectId="p1" />);
    const toggle = await screen.findByRole('switch', { name: 'Auto-restart api' });
    expect(toggle).toBeChecked();
    await userEvent.click(screen.getByRole('switch', { name: 'Auto-restart dev' }));
    await waitFor(() => expect(callsTo('setAutoRestart')).toEqual([{ script: 'dev', enabled: true }]));
  });

  it('shows the output when the name is clicked', async () => {
    installScriptsBridge({ scripts });
    renderWithProviders(<ScriptList projectId="p1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'api' }));
    expect(useUiStore.getState().scriptPanes['p1']?.scripts).toEqual(['api']);
  });

  it('toasts a failed start', async () => {
    installScriptsBridge({
      scripts,
      methods: {
        start: () => {
          throw new NestboxError('CONFLICT', 'The script is already running');
        },
      },
    });
    renderWithProviders(<ScriptList projectId="p1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start dev' }));
    expect(await screen.findByText('The script is already running')).toBeInTheDocument();
  });

  it('shows an amber Node badge with the version warning', async () => {
    installScriptsBridge({
      scripts,
      processes: [makeProcess({ script: 'dev', warning: "Node v20.11.1 doesn't match 18 (.nvmrc)" })],
    });
    renderWithProviders(<ScriptList projectId="p1" />);
    const badge = await screen.findByLabelText("Version warning: Node v20.11.1 doesn't match 18 (.nvmrc)");
    expect(badge).toHaveTextContent('Node');
    expect(badge).toHaveAttribute('title', "Node v20.11.1 doesn't match 18 (.nvmrc)");
  });

  describe('commands', () => {
    const mixed = [
      { name: 'dev', command: 'vite', autoRestart: false, kind: 'npm' as const, envFile: null, main: false },
      { name: 'seed', command: 'python seed.py --count 10', autoRestart: false, kind: 'custom' as const, envFile: null, main: false },
    ];

    it('marks custom commands; only they can be edited or deleted', async () => {
      installScriptsBridge({ scripts: mixed });
      renderWithProviders(<ScriptList projectId="p1" />);
      expect(await screen.findByText('python seed.py --count 10')).toBeInTheDocument();
      expect(screen.getByTitle('Added by you')).toHaveTextContent('custom');
      expect(screen.getByRole('button', { name: 'Edit seed' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit dev' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Delete dev' })).toBeNull();
    });

    it('opens the editor with the command filled in', async () => {
      installScriptsBridge({ scripts: mixed });
      renderWithProviders(<ScriptList projectId="p1" />);
      await userEvent.click(await screen.findByRole('button', { name: 'Edit seed' }));
      expect(await screen.findByRole('heading', { name: 'Edit command' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Command' })).toHaveValue('python seed.py --count 10');
    });

    it('deletes a custom command after asking', async () => {
      const { callsTo } = installScriptsBridge({ scripts: mixed });
      renderWithProviders(<ScriptList projectId="p1" />);
      await userEvent.click(await screen.findByRole('button', { name: 'Delete seed' }));
      expect(callsTo('deleteCommand')).toEqual([]);
      await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(callsTo('deleteCommand')).toEqual([{ name: 'seed' }]));
    });

    it('offers Add command, also when there is nothing to run yet', async () => {
      installScriptsBridge({ scripts: [] });
      renderWithProviders(<ScriptList projectId="p1" />);
      expect(await screen.findByText('No scripts or commands yet.')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Add command' }));
      expect(await screen.findByRole('heading', { name: 'Add command' })).toBeInTheDocument();
    });
  });

  describe('env file and main', () => {
    const dev = { name: 'dev', command: 'vite', autoRestart: false, kind: 'npm' as const, envFile: null, main: false };
    const api = { name: 'api', command: 'nest start --watch', autoRestart: true, kind: 'npm' as const, envFile: null, main: false };

    it("chooses the env file a row's process gets", async () => {
      const { callsTo } = installScriptsBridge({ scripts, envFiles: ['.env', '.env.local'] });
      renderWithProviders(<ScriptList projectId="p1" />);
      const select = await screen.findByRole('combobox', { name: 'Env file for dev' });
      expect(select).toHaveValue('');
      await userEvent.selectOptions(select, '.env.local');
      await waitFor(() => expect(callsTo('setEnvFile')).toEqual([{ script: 'dev', file: '.env.local' }]));
    });

    it('shows a chosen env file that is missing', async () => {
      installScriptsBridge({ scripts: [{ ...dev, envFile: '.env' }], envFiles: [] });
      renderWithProviders(<ScriptList projectId="p1" />);
      expect(await screen.findByRole('option', { name: '.env (missing)' })).toBeInTheDocument();
    });

    it('makes a row the main one, and clears it', async () => {
      const { callsTo } = installScriptsBridge({ scripts: [{ ...api, main: true }, dev] });
      renderWithProviders(<ScriptList projectId="p1" />);
      await userEvent.click(await screen.findByRole('button', { name: 'Make dev the main command' }));
      const main = screen.getByRole('button', { name: 'api is the main command' });
      expect(main).toHaveAttribute('aria-pressed', 'true');
      await userEvent.click(main);
      await waitFor(() =>
        expect(callsTo('setMain')).toEqual([
          { script: 'dev', main: true },
          { script: 'api', main: false },
        ]),
      );
    });
  });

  describe('detected commands', () => {
    const detected = [
      { name: 'main', command: 'python main.py', autoRestart: false, kind: 'detected' as const, envFile: '.env', main: false },
      { name: 'seed', command: 'python seed.py', autoRestart: false, kind: 'custom' as const, envFile: '.env', main: false },
    ];

    it('marks them, and removes one without asking and restores a removed one', async () => {
      const { callsTo } = installScriptsBridge({
        scripts: detected,
        hidden: [{ name: 'pytest', command: 'python -m pytest' }],
      });
      renderWithProviders(<ScriptList projectId="p1" />);
      expect(await screen.findByText('detected')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit main' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Remove seed' })).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Remove main' }));
      await waitFor(() => expect(callsTo('hideCommand')).toEqual([{ name: 'main' }]));
      expect(screen.getByText('Removed:').closest('p')).toHaveTextContent('pytest');
      await userEvent.click(screen.getByRole('button', { name: 'Restore pytest' }));
      await waitFor(() => expect(callsTo('showCommand')).toEqual([{ name: 'pytest' }]));
    });
  });

  describe('Python environment', () => {
    const python = { choice: 'auto' as const, venv: '.venv', auto: '.venv' };

    it('shows the one in use and picks another found in the project', async () => {
      const { callsTo } = installScriptsBridge({ scripts, python, pythonEnvs: ['.venv', 'backend/venv'] });
      renderWithProviders(<ScriptList projectId="p1" />);
      const select = await screen.findByRole('combobox', { name: 'Python environment' });
      expect(select).toHaveValue('auto');
      expect(await screen.findByRole('option', { name: 'Auto: .venv' })).toBeInTheDocument();
      await screen.findByRole('option', { name: 'backend/venv' });
      await userEvent.selectOptions(select, 'backend/venv');
      await waitFor(() => expect(callsTo('setVenv')).toEqual([{ mode: 'path', path: 'backend/venv' }]));
    });

    it('chooses system Python, or a folder typed in', async () => {
      const { callsTo } = installScriptsBridge({ scripts, python: { choice: 'none', venv: null, auto: null } });
      renderWithProviders(<ScriptList projectId="p1" />);
      const select = await screen.findByRole('combobox', { name: 'Python environment' });
      expect(select).toHaveValue('none');
      expect(screen.getByRole('option', { name: 'Auto: none found' })).toBeInTheDocument();
      await userEvent.selectOptions(select, 'other');
      await userEvent.type(screen.getByRole('textbox', { name: 'Virtualenv folder' }), '/opt/envs/api');
      await userEvent.click(screen.getByRole('button', { name: 'Use' }));
      await waitFor(() => expect(callsTo('setVenv')).toEqual([{ mode: 'path', path: '/opt/envs/api' }]));
      await userEvent.selectOptions(select, 'auto');
      await waitFor(() => expect(callsTo('setVenv')).toContainEqual({ mode: 'auto' }));
    });

    it('lists a chosen folder outside the project as the current choice', async () => {
      installScriptsBridge({ scripts, python: { choice: 'path', venv: '/opt/envs/api', auto: '.venv' } });
      renderWithProviders(<ScriptList projectId="p1" />);
      expect(await screen.findByRole('combobox', { name: 'Python environment' })).toHaveValue('/opt/envs/api');
    });

    it('is not offered outside Python packages', async () => {
      installScriptsBridge({ scripts });
      renderWithProviders(<ScriptList projectId="p1" />);
      await screen.findByText('vite');
      expect(screen.queryByRole('combobox', { name: 'Python environment' })).toBeNull();
    });
  });
});
