import { describe, expect, it } from 'vitest';
import type { PlatformAdapter } from '../platform/adapter';
import { dotnetModule } from './dotnet';

describe('dotnetModule', () => {
  describe('detect', () => {
    it('detects .sln files', async () => {
      const files = new Set(['MySolution.sln', 'README.md']);
      const dirs = new Set(['src']);

      const result = await dotnetModule.detect('/test/dir', files, dirs);

      expect(result).toEqual({
        projectFile: 'MySolution.sln',
        targetFramework: null,
        isWeb: false,
      });
    });

    it('detects .csproj files', async () => {
      const files = new Set(['MyApp.csproj', 'Program.cs']);
      const dirs = new Set(['src']);

      const result = await dotnetModule.detect('/test/dir', files, dirs);

      expect(result).toEqual({
        projectFile: 'MyApp.csproj',
        targetFramework: null,
        isWeb: false,
      });
    });

    it('detects .fsproj files', async () => {
      const files = new Set(['MyApp.fsproj', 'Program.fs']);
      const dirs = new Set(['src']);

      const result = await dotnetModule.detect('/test/dir', files, dirs);

      expect(result).toEqual({
        projectFile: 'MyApp.fsproj',
        targetFramework: null,
        isWeb: false,
      });
    });

    it('prefers .sln over .csproj', async () => {
      const files = new Set(['MySolution.sln', 'MyApp.csproj', 'README.md']);
      const dirs = new Set(['src']);

      const result = await dotnetModule.detect('/test/dir', files, dirs);

      expect(result?.projectFile).toBe('MySolution.sln');
    });

    it('returns null when no .NET files exist', async () => {
      const files = new Set(['package.json', 'README.md']);
      const dirs = new Set(['src']);

      const result = await dotnetModule.detect('/test/dir', files, dirs);

      expect(result).toBeNull();
    });
  });

  describe('tasks', () => {
    it('returns standard .NET tasks', () => {
      const info = {
        projectFile: 'MyApp.csproj',
        targetFramework: 'net8.0',
        isWeb: false,
      };

      const tasks = dotnetModule.tasks(info);

      expect(tasks).toEqual([
        { name: 'run', argv: ['dotnet', 'run', '--project', 'MyApp.csproj'], title: 'Run' },
        { name: 'build', argv: ['dotnet', 'build', 'MyApp.csproj'], title: 'Build' },
        { name: 'test', argv: ['dotnet', 'test', 'MyApp.csproj'], title: 'Test' },
        { name: 'restore', argv: ['dotnet', 'restore', 'MyApp.csproj'], title: 'Restore packages' },
        { name: 'clean', argv: ['dotnet', 'clean', 'MyApp.csproj'], title: 'Clean' },
      ]);
    });
  });

  describe('runEnv', () => {
    it('returns empty environment', async () => {
      const info = {
        projectFile: 'MyApp.csproj',
        targetFramework: 'net8.0',
        isWeb: false,
      };
      const ctx = {
        dir: '/test/dir',
        rootDir: '/test/dir',
        platform: {} as PlatformAdapter,
        settings: {},
      };

      const env = await dotnetModule.runEnv(ctx, info);

      expect(env).toEqual({});
    });
  });

  describe('summary', () => {
    it('returns .NET for basic projects', () => {
      const info = {
        projectFile: 'MyApp.csproj',
        targetFramework: null,
        isWeb: false,
      };

      const summary = dotnetModule.summary?.(info);

      expect(summary).toBe('.NET');
    });

    it('includes target framework when available', () => {
      const info = {
        projectFile: 'MyApp.csproj',
        targetFramework: 'net8.0',
        isWeb: false,
      };

      const summary = dotnetModule.summary?.(info);

      expect(summary).toBe('.NET · net8.0');
    });

    it('includes Web indicator for web projects', () => {
      const info = {
        projectFile: 'MyApp.csproj',
        targetFramework: 'net8.0',
        isWeb: true,
      };

      const summary = dotnetModule.summary?.(info);

      expect(summary).toBe('.NET · net8.0 · Web');
    });
  });

  describe('packageGlobs', () => {
    it('includes .NET project file patterns', () => {
      expect(dotnetModule.packageGlobs).toEqual(['**/*.csproj', '**/*.fsproj', '**/*.sln']);
    });
  });
});
