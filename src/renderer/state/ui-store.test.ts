import { describe, expect, it } from 'vitest';
import { useUiStore } from './ui-store';

describe('ui store', () => {
  it('tracks selection, tabs per project, filter and collapsed groups', () => {
    const s = useUiStore.getState();
    s.select('p1');
    s.setActiveTab('p1', 'project-info');
    s.setFilter('sho');
    s.toggleCollapsed('p1');
    expect(useUiStore.getState()).toMatchObject({
      selectedProjectId: 'p1',
      activeTab: { p1: 'project-info' },
      filter: 'sho',
      collapsed: { p1: true },
    });
    useUiStore.getState().toggleCollapsed('p1');
    expect(useUiStore.getState().collapsed['p1']).toBe(false);
  });
});

describe('views', () => {
  it('switches to the Ports page and back when a project is selected', () => {
    const s = () => useUiStore.getState();
    expect(s().view).toBe('project');
    s().showPorts();
    expect(s().view).toBe('ports');
    s().select('p1');
    expect(s()).toMatchObject({ view: 'project', selectedProjectId: 'p1' });
  });
});

describe('script panes', () => {
  const ref = (script: string, projectId = 'p1') => ({ projectId, script });

  it('fills the active pane and splits into two', () => {
    const s = () => useUiStore.getState();
    s().showScript('p1', 'dev');
    expect(s().scriptPanes['p1']).toEqual({ scripts: [ref('dev')], active: 0 });
    s().toggleSplit('p1');
    expect(s().scriptPanes['p1']).toEqual({ scripts: [ref('dev'), null], active: 1 });
    s().showScript('p1', 'api');
    expect(s().scriptPanes['p1']?.scripts).toEqual([ref('dev'), ref('api')]);
    s().setActivePane('p1', 0);
    s().showScript('p1', 'build');
    expect(s().scriptPanes['p1']?.scripts).toEqual([ref('build'), ref('api')]);
    s().setPaneScript('p1', 1, ref('web'));
    expect(s().scriptPanes['p1']).toEqual({ scripts: [ref('build'), ref('web')], active: 1 });
    s().toggleSplit('p1');
    expect(s().scriptPanes['p1']).toEqual({ scripts: [ref('build')], active: 0 });
  });

  it("shows a package's script in its root's panes", () => {
    const s = () => useUiStore.getState();
    s().showScript('r1', 'dev', 'r1::api');
    expect(s().scriptPanes['r1']?.scripts).toEqual([ref('dev', 'r1::api')]);
    expect(s().scriptPanes['r1::api']).toBeUndefined();
  });
});
