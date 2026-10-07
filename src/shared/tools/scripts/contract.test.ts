import { describe, expect, it } from 'vitest';
import { makeDetectedForTest } from '../../test-fixtures';
import { MAX_EXPORT_SEQS, scriptsContract, scriptsDefinition } from './contract';

describe('scripts contract', () => {
  it('applies to every package and to workspace roots', () => {
    expect(scriptsDefinition.appliesTo(makeDetectedForTest({ packageJson: { scripts: { dev: 'vite' } } }))).toBe(true);
    // No scripts: custom commands still run there.
    expect(scriptsDefinition.appliesTo(makeDetectedForTest({ packageJson: { scripts: {} } }))).toBe(true);
    expect(scriptsDefinition.appliesTo(makeDetectedForTest({ packageJson: null, workspaces: [makeDetectedForTest()] }))).toBe(true);
    expect(scriptsDefinition.appliesTo(makeDetectedForTest({ packageJson: null }))).toBe(false);
  });

  it('defaults its settings', () => {
    expect(scriptsDefinition.settingsSchema.parse({})).toEqual({ autoRestart: [], commands: [], envFiles: [], main: [], hidden: {}, venvs: [] });
  });

  it('bounds the export selection', () => {
    const seqs = Array.from({ length: MAX_EXPORT_SEQS + 1 }, (_, i) => i + 1);
    expect(scriptsContract.exportLogs.input.safeParse({ script: 'dev', seqs }).success).toBe(false);
    expect(scriptsContract.exportLogs.input.safeParse({ script: 'dev', seqs: 'all' }).success).toBe(true);
  });
});
