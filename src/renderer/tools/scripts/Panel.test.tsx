import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useNavigateSubscription } from '@/lib/navigate';
import { useUiStore } from '@/state/ui-store';
import { makeProcess } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { ScriptsCard } from './OverviewCard';
import ScriptsPanel from './Panel';
import { installScriptsBridge } from './test-bridge';

const scripts = [
  { name: 'dev', command: 'vite', autoRestart: false, kind: 'npm' as const, envFile: null, main: false },
  { name: 'api', command: 'nest start', autoRestart: false, kind: 'npm' as const, envFile: null, main: false },
];

describe('ScriptsPanel', () => {
  it('shows the script list and one pane, then splits', async () => {
    installScriptsBridge({ scripts });
    renderWithProviders(<ScriptsPanel projectId="p1" />);
    expect(await screen.findByRole('region', { name: 'Scripts' })).toBeInTheDocument();
    expect(screen.getAllByRole('region', { name: 'Log pane' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Split' }));
    expect(screen.getAllByRole('region', { name: 'Log pane' })).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'api' }));
    expect(await screen.findByRole('region', { name: 'api log' })).toBeInTheDocument();
    expect(useUiStore.getState().scriptPanes['p1']).toEqual({
      scripts: [null, { projectId: 'p1', script: 'api' }],
      active: 1,
    });
  });

  it('keeps the panes in the store across remounts', async () => {
    installScriptsBridge({ scripts });
    useUiStore.getState().showScript('p1', 'dev');
    const { unmount } = renderWithProviders(<ScriptsPanel projectId="p1" />);
    expect(await screen.findByRole('region', { name: 'dev log' })).toBeInTheDocument();
    unmount();
    renderWithProviders(<ScriptsPanel projectId="p1" />);
    expect(await screen.findByRole('region', { name: 'dev log' })).toBeInTheDocument();
  });
});

describe('ScriptsCard', () => {
  it('lists live and crashed processes of the project and its workspaces', async () => {
    installScriptsBridge({
      processes: [
        makeProcess({ projectId: 'p1', script: 'dev', state: 'running' }),
        makeProcess({ projectId: 'p1::packages/api', script: 'dev', state: 'crashed' }),
        makeProcess({ projectId: 'p1', script: 'build', state: 'exited' }),
        makeProcess({ projectId: 'p2', script: 'dev', state: 'running' }),
      ],
    });
    renderWithProviders(<ScriptsCard projectId="p1" />);
    expect(await screen.findByText('packages/api · dev')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Open Scripts' }));
    expect(useUiStore.getState().activeTab['p1']).toBe('scripts');
  });

  it('says when nothing runs', async () => {
    installScriptsBridge();
    renderWithProviders(<ScriptsCard projectId="p1" />);
    expect(await screen.findByText('No scripts running.')).toBeInTheDocument();
  });
});

function Navigator() {
  useNavigateSubscription();
  return null;
}

describe('useNavigateSubscription', () => {
  it('selects the project, opens the tab and shows the script', async () => {
    const { bridge } = installScriptsBridge();
    renderWithProviders(<Navigator />);
    act(() => bridge.emit('app:navigate', { projectId: 'p1::packages/api', tab: 'scripts', script: 'dev' }));
    await waitFor(() => expect(useUiStore.getState().selectedProjectId).toBe('p1::packages/api'));
    expect(useUiStore.getState().activeTab['p1::packages/api']).toBe('scripts');
    expect(useUiStore.getState().scriptPanes['p1::packages/api']?.scripts).toEqual([
      { projectId: 'p1::packages/api', script: 'dev' },
    ]);
  });

  it('ignores an invalid payload', () => {
    const { bridge } = installScriptsBridge();
    renderWithProviders(<Navigator />);
    act(() => bridge.emit('app:navigate', { tab: 'scripts' }));
    expect(useUiStore.getState().selectedProjectId).toBeNull();
  });
});
