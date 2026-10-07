# Adding a New Ecosystem Module

This guide explains how to add support for a new programming language or framework to NestBox's ecosystem system.

## Overview

The ecosystem framework allows NestBox to detect and provide commands for projects in any language or framework. Each ecosystem module:

- Detects projects by examining files in a directory
- Provides a list of runnable tasks (build, test, run, etc.)
- Optionally customizes the runtime environment (PATH, env vars)
- Integrates automatically with the Scripts tool

## Step-by-Step Guide

### 1. Create Your Module File

Create `src/main/ecosystems/<language>.ts` (e.g., `python.ts`, `go.ts`, `rust.ts`).

### 2. Define Your Info Schema

Use Zod to define what information your detector captures:

```typescript
import { z } from 'zod';
import type { EcosystemModule } from './types';

const PythonInfoSchema = z.object({
  // What your detector finds
  hasRequirementsTxt: z.boolean(),
  hasPyprojectToml: z.boolean(),
  venvPath: z.string().nullable(),
  pythonVersion: z.string().nullable(),
});

type PythonInfo = z.infer<typeof PythonInfoSchema>;
```

### 3. Implement the Module

```typescript
export const pythonModule: EcosystemModule<PythonInfo> = {
  // Must match an entry in EcosystemId type (see types.ts)
  id: 'python',
  
  // Your Zod schema
  infoSchema: PythonInfoSchema,

  /**
   * Detect if this directory contains a project of your type.
   * This is PURE: no file I/O, no subprocess, no Electron APIs.
   * Only use the provided files and dirs sets.
   */
  async detect(
    dir: string,
    files: ReadonlySet<string>,
    dirs: ReadonlySet<string>
  ): Promise<PythonInfo | null> {
    // Check for marker files
    if (!files.has('requirements.txt') && !files.has('pyproject.toml')) {
      return null;
    }

    return {
      hasRequirementsTxt: files.has('requirements.txt'),
      hasPyprojectToml: files.has('pyproject.toml'),
      venvPath: dirs.has('.venv') ? '.venv' : null,
      pythonVersion: null, // Can't determine without subprocess
    };
  },

  /**
   * Glob patterns that identify workspace packages.
   * Used for multi-folder projects (e.g., monorepos).
   */
  packageGlobs: ['**/pyproject.toml', '**/setup.py'],

  /**
   * Generate the list of runnable tasks for this project.
   * Each task becomes a command in the Scripts tool.
   */
  tasks(info: PythonInfo) {
    const tasks = [];

    // Common Python tasks
    if (info.hasPyprojectToml) {
      tasks.push(
        { name: 'install', argv: ['pip', 'install', '-e', '.'], title: 'Install package' },
        { name: 'build', argv: ['python', '-m', 'build'], title: 'Build' }
      );
    }

    if (info.hasRequirementsTxt) {
      tasks.push({
        name: 'install-deps',
        argv: ['pip', 'install', '-r', 'requirements.txt'],
        title: 'Install dependencies'
      });
    }

    // Always provide test runner
    tasks.push({
      name: 'test',
      argv: ['pytest'],
      title: 'Run tests'
    });

    return tasks;
  },

  /**
   * Customize the runtime environment for tasks.
   * Return PATH prepends, env vars, and an optional note.
   */
  async runEnv(ctx, info: PythonInfo) {
    if (info.venvPath) {
      const binDir = ctx.platform.isWindows
        ? `${info.venvPath}/Scripts`
        : `${info.venvPath}/bin`;

      return {
        pathPrepend: binDir,
        note: `Using ${info.venvPath}`,
      };
    }

    return {}; // No customization needed
  },

  /**
   * One-line summary for the project-info panel.
   * Optional but recommended.
   */
  summary(info: PythonInfo): string | null {
    const parts = ['Python'];
    if (info.pythonVersion) parts.push(info.pythonVersion);
    if (info.venvPath) parts.push(info.venvPath);
    return parts.join(' · ');
  },
};
```

### 4. Update the EcosystemId Type

Add your language to `src/main/ecosystems/types.ts`:

```typescript
export type EcosystemId = 'python' | 'dotnet' | 'node' | 'rust' | 'go';
```

### 5. Register Your Module

Add it to the registry in `src/main/ecosystems/index.ts`:

```typescript
import { pythonModule } from './python';
import { dotnetModule } from './dotnet';

export const ECOSYSTEM_MODULES: ReadonlyArray<EcosystemModule<unknown, unknown>> = [
  pythonModule,
  dotnetModule,
  // Add yours here
];
```

**Order matters**: Modules are checked in array order. Put more specific detectors before generic ones.

### 6. Write Tests

Create `src/main/ecosystems/<language>.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { PlatformAdapter } from '../platform/adapter';
import { pythonModule } from './python';

describe('pythonModule', () => {
  describe('detect', () => {
    it('detects requirements.txt projects', async () => {
      const files = new Set(['requirements.txt', 'main.py']);
      const dirs = new Set(['src']);

      const result = await pythonModule.detect('/test/dir', files, dirs);

      expect(result).toEqual({
        hasRequirementsTxt: true,
        hasPyprojectToml: false,
        venvPath: null,
        pythonVersion: null,
      });
    });

    it('returns null for non-Python projects', async () => {
      const files = new Set(['package.json', 'index.js']);
      const dirs = new Set(['src']);

      const result = await pythonModule.detect('/test/dir', files, dirs);

      expect(result).toBeNull();
    });
  });

  describe('tasks', () => {
    it('provides pytest for all projects', () => {
      const info = {
        hasRequirementsTxt: true,
        hasPyprojectToml: false,
        venvPath: null,
        pythonVersion: null,
      };

      const tasks = pythonModule.tasks(info);

      expect(tasks).toContainEqual({
        name: 'test',
        argv: ['pytest'],
        title: 'Run tests',
      });
    });
  });

  describe('runEnv', () => {
    it('adds venv to PATH when present', async () => {
      const info = {
        hasRequirementsTxt: true,
        hasPyprojectToml: false,
        venvPath: '.venv',
        pythonVersion: null,
      };
      const ctx = {
        dir: '/test/dir',
        platform: { isWindows: false } as PlatformAdapter,
        settings: {},
      };

      const env = await pythonModule.runEnv(ctx, info);

      expect(env).toEqual({
        pathPrepend: '.venv/bin',
        note: 'Using .venv',
      });
    });
  });
});
```

### 7. Run Tests and Checks

```bash
pnpm test src/main/ecosystems/<language>.test.ts
pnpm typecheck
pnpm lint
pnpm test  # Full suite
```

## Design Principles

### Pure Detection

The `detect()` method must be **pure** and **fast**:
- ✅ Check file/dir existence in the provided sets
- ✅ Pattern matching on file names
- ❌ No file I/O (`readFile`, `stat`, etc.)
- ❌ No subprocess execution
- ❌ No Electron APIs

**Why?** Detection runs for every directory during project scanning. Keeping it pure makes it:
- Fast (no I/O)
- Testable (no mocking needed)
- Reliable (no race conditions)

If you need file contents or subprocess output, parse it in `runEnv()` or defer it to a future enhancement.

### Task Design

**Good tasks:**
- Have clear, unique names within the ecosystem
- Use explicit argv (no shell)
- Include a human-readable title
- Work from the project directory

**Examples:**
```typescript
// ✅ Good
{ name: 'test', argv: ['pytest', '--verbose'], title: 'Run tests' }

// ❌ Bad - shell command
{ name: 'test', argv: ['sh', '-c', 'pytest --verbose'], title: 'Run tests' }

// ❌ Bad - unclear name
{ name: 'cmd1', argv: ['pytest'], title: 'Run tests' }
```

### RunEnv vs Detection

- **Detection**: Identifies the project type, captures static metadata
- **RunEnv**: Customizes the runtime environment, can do I/O if needed

If you need to parse a config file or run a subprocess to determine the environment, do it in `runEnv()`, not `detect()`.

## Integration Points

Your module integrates automatically with:

1. **Project detection** (`detectProject()`): Runs during initial scan and rescan
2. **Scripts tool**: Tasks appear as `'detected'` kind commands; the user can remove (hide) and restore them
3. **Run environment**: `runEnv()` applies to the package's detected tasks *and* its custom commands. It gets
   `dir` (the package), `rootDir` (the project folder) and `settings` (`EcosystemChoices`, e.g. the virtualenv
   the user picked). It may return `programs` to swap the command's first word (`{ python: 'python3' }`).
4. **Project-info**: `summary()` appears in the overview card and the info panel
5. **Workspace detection**: `packageGlobs` match marker files (`*/pyproject.toml`, `**/*.csproj`); each match's
   folder becomes a package, unless it sits inside a Node package
6. **Add command dialog** (optional): `files()` lists files to run, with the argv each one becomes

## Testing Strategy

Test these scenarios:

1. **Detection**
   - Positive cases (marker files present)
   - Negative cases (not this ecosystem)
   - Edge cases (multiple marker files, precedence)

2. **Tasks**
   - Task list matches info
   - Conditional tasks based on detected features
   - All tasks have valid argv and titles

3. **RunEnv**
   - PATH prepending on Windows and Unix
   - Environment variables
   - Notes for user feedback

4. **Summary**
   - Format consistency
   - All info variants

## Examples

See existing modules:
- [`python/`](../src/main/ecosystems/python/index.ts) - Names-only detection, a virtualenv picked in `runEnv` (the package's own, the project folder's, or the user's choice), a program swap (`python` → `python3`) and a `files()` picker
- [`dotnet.ts`](../src/main/ecosystems/dotnet.ts) - Simple, file-extension based detection
- [`test-module.ts`](../src/main/ecosystems/test-module.ts) - Test fixture showing all features

## Common Patterns

### Multi-Tool Detection

```typescript
async detect(dir, files, dirs) {
  // Check for multiple package managers
  const hasPoetry = files.has('poetry.lock');
  const hasPipenv = files.has('Pipfile');
  const hasUv = files.has('uv.lock');

  if (!hasPoetry && !hasPipenv && !hasUv && !files.has('requirements.txt')) {
    return null;
  }

  return { hasPoetry, hasPipenv, hasUv, ... };
}
```

### Conditional Tasks

```typescript
tasks(info) {
  const tasks = [];

  // Tool-specific tasks
  if (info.hasPoetry) {
    tasks.push({ name: 'poetry-install', argv: ['poetry', 'install'], title: 'Install with Poetry' });
  }
  if (info.hasPipenv) {
    tasks.push({ name: 'pipenv-install', argv: ['pipenv', 'install'], title: 'Install with Pipenv' });
  }

  // Universal tasks
  tasks.push({ name: 'test', argv: ['pytest'], title: 'Run tests' });

  return tasks;
}
```

### Platform-Specific Paths

Platform differences live in the platform adapter (only `src/main/platform/` may read `process.platform`), so
a module asks the adapter instead of checking the OS itself:

```typescript
async runEnv(ctx, info) {
  if (!info.venvPath) return { programs: { python: ctx.platform.pythonCommand } }; // python3 on macOS

  const venv = join(ctx.dir, info.venvPath);
  return { pathPrepend: ctx.platform.venvBinDir(venv) }; // Scripts\ on Windows, bin/ elsewhere
}
```

## Troubleshooting

**Module not detecting**: Check the order in `ECOSYSTEM_MODULES`. Earlier modules shadow later ones.

**Tasks not appearing**: Verify the module is registered and `tasks()` returns valid `DetectedTask` objects with `name`, `argv`, and `title`.

**PATH not working**: Check platform-specific path separators in `runEnv()`.

**Tests failing**: Ensure you're not using `any` types and all unused parameters are prefixed with `_`.

## Questions?

Check the [ecosystem spec](../specs/2026-10-07-nestbox-v2-ecosystems-plan.md) for design rationale, or look at the existing `.NET` module as a reference implementation.
