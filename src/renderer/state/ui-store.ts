import { create } from 'zustand';

/** A script of a package: a root's Scripts tab also shows its packages' favorites. */
export interface PaneScript {
  projectId: string;
  script: string;
}

/** Log panes of a project's Scripts tab: one or two, each showing a script (or none yet). */
export interface ScriptPanes {
  scripts: (PaneScript | null)[];
  /** The pane a click in the script list fills. */
  active: number;
}

export const DEFAULT_PANES: ScriptPanes = { scripts: [null], active: 0 };

export interface UiData {
  /** What main shows: the selected project, the machine-wide Ports page, or the Dependencies page. */
  view: 'project' | 'ports' | 'deps';
  selectedProjectId: string | null;
  /** Active tab per project id; 'overview' when unset. */
  activeTab: Record<string, string>;
  filter: string;
  /** Collapsed workspace groups by root project id. */
  collapsed: Record<string, boolean>;
  /** Scripts tab panes per project id. */
  scriptPanes: Record<string, ScriptPanes>;
  settingsOpen: boolean;
  /** A picked folder that splits into sub-folder projects, waiting for "Add under a group?" (v1.20). */
  pendingFolders: PendingFolders | null;
}

export interface PendingFolders {
  path: string;
  name: string;
  folders: { relPath: string; name: string }[];
}

export interface UiState extends UiData {
  /** Selects a project and shows it (leaving the Ports page). */
  select(id: string | null): void;
  showPorts(): void;
  showDeps(): void;
  setActiveTab(projectId: string, tab: string): void;
  setFilter(filter: string): void;
  toggleCollapsed(projectId: string): void;
  /** Shows a script in the project's active pane; `owner` is the package it belongs to (the project by default). */
  showScript(projectId: string, script: string, owner?: string): void;
  setPaneScript(projectId: string, pane: number, script: PaneScript): void;
  setActivePane(projectId: string, pane: number): void;
  /** One pane ↔ two panes; closing the split keeps pane 0. */
  toggleSplit(projectId: string): void;
  setSettingsOpen(open: boolean): void;
  setPendingFolders(pending: PendingFolders | null): void;
}

export const initialUiState: UiData = {
  view: 'project',
  selectedProjectId: null,
  activeTab: {},
  filter: '',
  collapsed: {},
  scriptPanes: {},
  settingsOpen: false,
  pendingFolders: null,
};

const panesOf = (s: UiData, projectId: string): ScriptPanes => s.scriptPanes[projectId] ?? DEFAULT_PANES;

export const useUiStore = create<UiState>()((set) => {
  const setPanes = (projectId: string, fn: (p: ScriptPanes) => ScriptPanes) =>
    set((s) => ({ scriptPanes: { ...s.scriptPanes, [projectId]: fn(panesOf(s, projectId)) } }));
  return {
    ...initialUiState,
    select: (id) => set({ selectedProjectId: id, view: 'project' }),
    showPorts: () => set({ view: 'ports' }),
    setPendingFolders: (pendingFolders) => set({ pendingFolders }),
    showDeps: () => set({ view: 'deps' }),
    setActiveTab: (projectId, tab) => set((s) => ({ activeTab: { ...s.activeTab, [projectId]: tab } })),
    setFilter: (filter) => set({ filter }),
    toggleCollapsed: (projectId) =>
      set((s) => ({ collapsed: { ...s.collapsed, [projectId]: !s.collapsed[projectId] } })),
    showScript: (projectId, script, owner = projectId) =>
      setPanes(projectId, (p) => ({
        ...p,
        scripts: p.scripts.map((s, i) => (i === p.active ? { projectId: owner, script } : s)),
      })),
    setPaneScript: (projectId, pane, script) =>
      setPanes(projectId, (p) => ({ active: pane, scripts: p.scripts.map((s, i) => (i === pane ? script : s)) })),
    setActivePane: (projectId, pane) => setPanes(projectId, (p) => ({ ...p, active: pane })),
    toggleSplit: (projectId) =>
      setPanes(projectId, (p) =>
        p.scripts.length > 1 ? { scripts: [p.scripts[0] ?? null], active: 0 } : { scripts: [p.scripts[0] ?? null, null], active: 1 },
      ),
    setSettingsOpen: (open) => set({ settingsOpen: open }),
  };
});
