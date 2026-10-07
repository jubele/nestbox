import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeProcess } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { ScriptsCard } from './OverviewCard';
import { installScriptsBridge } from './test-bridge';

describe('ScriptsCard', () => {
  it("starts each package's main command from a root's card", async () => {
    const { calls } = installScriptsBridge({
      scripts: [],
      packages: [
        { relPath: '', name: 'app', scripts: [], compose: false, main: null },
        { relPath: 'backend', name: 'backend', scripts: ['dev'], compose: false, main: 'dev' },
        { relPath: 'frontend', name: 'web', scripts: ['dev'], compose: false, main: 'dev' },
      ],
      processes: [makeProcess({ projectId: 'p1::frontend', script: 'dev', state: 'running' })],
    });
    renderWithProviders(<ScriptsCard projectId="p1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start dev in backend' }));
    // The frontend's main is already running.
    expect(screen.queryByRole('button', { name: 'Start dev in web' })).toBeNull();
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'start')).toEqual([
        { projectId: 'p1::backend', method: 'start', input: { script: 'dev' } },
      ]),
    );
  });

  it("starts a package's own main command from its card", async () => {
    const { calls } = installScriptsBridge({
      scripts: [
        {
          name: 'api',
          command: 'python server.py',
          autoRestart: false,
          kind: 'custom',
          envFile: '.env',
          main: true,
        },
      ],
      packages: null,
      runGroups: null,
    });
    renderWithProviders(<ScriptsCard projectId="p1::backend" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start api' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'start').map((c) => c.input)).toEqual([
        { script: 'api' },
      ]),
    );
  });
});
