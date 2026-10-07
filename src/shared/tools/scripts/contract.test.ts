import { describe, expect, it } from 'vitest';
import { makeDetectedForTest } from '../../test-fixtures';
import { MAX_EXPORT_SEQS, scriptsContract, scriptsDefinition } from './contract';

describe('scripts contract', () => {
  it('applies to projects with scripts, Python or workspaces', () => {
    expect(scriptsDefinition.appliesTo(makeDetectedForTest({ packageJson: { scripts: { dev: 'vite' } } }))).toBe(true);
    expect(scriptsDefinition.appliesTo(makeDetectedForTest({ workspaces: [makeDetectedForTest()] }))).toBe(true);
    expect(scriptsDefinition.appliesTo(makeDetectedForTest({ packageJson: { scripts: {} } }))).toBe(false);
    expect(scriptsDefinition.appliesTo(makeDetectedForTest({ packageJson: null }))).toBe(false);
    expect(
      scriptsDefinition.appliesTo(
        makeDetectedForTest({ packageJson: null, python: { venv: null, framework: null, commands: [] } }),
      ),
    ).toBe(true);
  });

  it('defaults its settings', () => {
    expect(scriptsDefinition.settingsSchema.parse({})).toEqual({ autoRestart: [], commands: [], envFiles: [], main: [], hidden: [], venvs: [] });
  });

  it('bounds the export selection', () => {
    const seqs = Array.from({ length: MAX_EXPORT_SEQS + 1 }, (_, i) => i + 1);
    expect(scriptsContract.exportLogs.input.safeParse({ script: 'dev', seqs }).success).toBe(false);
    expect(scriptsContract.exportLogs.input.safeParse({ script: 'dev', seqs: 'all' }).success).toBe(true);
  });
});
