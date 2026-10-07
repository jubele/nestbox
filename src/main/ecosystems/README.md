# Ecosystem Modules

This directory contains ecosystem modules that detect and provide commands for different programming languages and frameworks.

## Current Modules

- **python** - Python packages (pyproject.toml, requirements*.txt, Pipfile, setup.py/cfg, manage.py, or top-level `.py` files)
- **dotnet** - .NET projects (.sln, .csproj, .fsproj)

## Adding a New Module

See [docs/adding-ecosystems.md](../../docs/adding-ecosystems.md) for a complete guide.

**Quick start:**

1. Create `<language>.ts` with detection logic and task list
2. Add your ecosystem ID to `EcosystemId` in `types.ts`
3. Register in `index.ts` → `ECOSYSTEM_MODULES` array
4. Add tests in `<language>.test.ts`
5. Run `pnpm test` and `pnpm lint`

**Template:**

```typescript
import { z } from 'zod';
import type { EcosystemModule } from './types';

const MyInfoSchema = z.object({
  // What you detect
});

export const myModule: EcosystemModule<z.infer<typeof MyInfoSchema>> = {
  id: 'my-language',
  infoSchema: MyInfoSchema,
  
  async detect(dir, files, dirs) {
    // Return info or null
  },
  
  packageGlobs: ['**/marker-file'],
  
  tasks(info) {
    return [
      { name: 'build', argv: ['my-cli', 'build'], title: 'Build' },
    ];
  },
  
  async runEnv(ctx, info) {
    return {}; // or { pathPrepend, env, note }
  },
  
  summary(info) {
    return 'My Language';
  },
};
```

## Module Order

Modules in `ECOSYSTEM_MODULES` are checked in order. Put more specific detectors before generic ones.

## Key Constraints

- **detect()** must be pure (no I/O, no subprocess)
- **tasks()** must return valid DetectedTask[] with name, argv, title
- **Module IDs** must match the EcosystemId union type
- **Tests** should cover detection, tasks, runEnv, and summary

## Integration

Modules integrate automatically with:
- Project detection and scanning
- Scripts tool (tasks appear as 'detected' kind)
- Project-info panel (via summary())
- Workspace detection (via packageGlobs)
