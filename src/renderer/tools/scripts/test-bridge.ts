// Test helper for the Scripts tool's renderer tests.
import { NestboxError } from '@shared/errors';
import type { ProcessSummary } from '@shared/processes';
import type { PackageScripts, ScriptInfo } from '@shared/tools/scripts/contract';
import type { RunGroup } from '@shared/types';
import { installMockBridge } from '@/test/mock-bridge';

export interface ScriptsFixture {
  scripts?: ScriptInfo[];
  runGroups?: RunGroup[] | null;
  packages?: PackageScripts[] | null;
  processes?: ProcessSummary[];
  pythonFiles?: string[];
  hidden?: { name: string; command: string }[];
  python?: { choice: 'auto' | 'none' | 'path'; venv: string | null; auto: string | null } | null;
  pythonEnvs?: string[];
  /** Per-method overrides; return a value or throw. */
  methods?: Record<string, (input: never) => unknown>;
}

export function installScriptsBridge(fx: ScriptsFixture = {}) {
  const calls: { projectId: string; method: string; input: unknown }[] = [];
  const bridge = installMockBridge({
    'processes:list': () => fx.processes ?? [],
    'settings:get': () => {
      throw new NestboxError('NOT_FOUND', 'no settings in this test');
    },
    'tools:invoke': (({ projectId, method, input }: { projectId: string; method: string; input: unknown }) => {
      calls.push({ projectId, method, input });
      const override = fx.methods?.[method];
      if (override) return override(input as never);
      switch (method) {
        case 'list':
          return {
            scripts: fx.scripts ?? [{ name: 'dev', command: 'vite', autoRestart: false, kind: 'npm' }],
            runGroups: fx.runGroups === undefined ? [] : fx.runGroups,
            packages:
              fx.packages === undefined ? [{ relPath: '', name: 'shop', scripts: ['dev'], compose: false }] : fx.packages,
            hidden: fx.hidden ?? [],
            python: fx.python ?? null,
          };
        case 'getLogs':
          return { lines: [], firstSeq: 1, lastSeq: 0 };
        case 'setAutoRestart':
          return { enabled: (input as { enabled: boolean }).enabled };
        case 'startRunGroup':
          return { started: [], skipped: [], compose: [] };
        case 'pythonEnvs':
          return { envs: fx.pythonEnvs ?? [] };
        case 'pythonFiles':
          return { files: fx.pythonFiles ?? [] };
        case 'saveRunGroup':
        case 'deleteRunGroup':
          return [];
        default:
          return undefined;
      }
    }) as never,
  });
  return { bridge, calls, callsTo: (method: string) => calls.filter((c) => c.method === method).map((c) => c.input) };
}
