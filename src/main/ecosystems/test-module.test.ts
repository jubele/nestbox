import { describe, expect, it } from 'vitest';
import type { PlatformAdapter } from '../platform/adapter';
import { TEST_ECOSYSTEM_MODULE } from './test-module';

describe('TEST_ECOSYSTEM_MODULE', () => {
  describe('detect', () => {
    it('detects when test-marker.txt exists', async () => {
      const files = new Set(['test-marker.txt', 'README.md']);
      const dirs = new Set(['src']);

      const result = await TEST_ECOSYSTEM_MODULE.detect('/test/dir', files, dirs);

      expect(result).toEqual({
        version: '1.0.0',
        marker: 'test-marker.txt',
      });
    });

    it('returns null when marker is absent', async () => {
      const files = new Set(['README.md']);
      const dirs = new Set(['src']);

      const result = await TEST_ECOSYSTEM_MODULE.detect('/test/dir', files, dirs);

      expect(result).toBeNull();
    });
  });

  describe('tasks', () => {
    it('returns detected tasks', () => {
      const info = { version: '1.0.0', marker: 'test-marker.txt' };

      const tasks = TEST_ECOSYSTEM_MODULE.tasks(info);

      expect(tasks).toEqual([
        { name: 'test-run', argv: ['test-cmd', 'run'], title: 'Run tests' },
        { name: 'test-check', argv: ['test-cmd', 'check'], title: 'Check tests' },
      ]);
    });
  });

  describe('runEnv', () => {
    it('returns run environment', async () => {
      const info = { version: '1.0.0', marker: 'test-marker.txt' };
      const ctx = {
        dir: '/test/dir',
        rootDir: '/test/dir',
        platform: {} as PlatformAdapter,
        settings: {},
      };

      const env = await TEST_ECOSYSTEM_MODULE.runEnv(ctx, info);

      expect(env).toEqual({
        pathPrepend: '/test/bin',
        env: {
          TEST_VERSION: '1.0.0',
          TEST_MODE: 'test',
        },
        note: 'Using test module 1.0.0',
      });
    });
  });

  describe('summary', () => {
    it('returns summary string', () => {
      const info = { version: '1.0.0', marker: 'test-marker.txt' };

      const summary = TEST_ECOSYSTEM_MODULE.summary?.(info);

      expect(summary).toBe('Test 1.0.0');
    });
  });
});
