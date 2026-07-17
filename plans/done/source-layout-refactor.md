# Source layout refactor

## Goal
Move production code and its tests out of the repository root into cohesive `src/` domains without changing runtime behavior or the published extension contract.

## Intention
Improve locality and navigation first. This is deliberately a mechanical refactor; decomposing large modules is a separate follow-up after the structure is stable.

## Scope & Constraints
- No root-level compatibility entrypoint will be retained.
- Keep the public Pi extension and package export entry at `src/index.ts`.
- Co-locate tests with the module or domain they exercise.
- Preserve the existing `usage-coordination` module hierarchy under `src/usage/coordination/`.
- Update package metadata, TypeScript discovery, docs, scripts, fixtures, and loader tests.

## Work Plan
1. Move tracked TypeScript source and tests into `src/` domains and `test/fixtures/`.
2. Rewrite relative imports based on the new file locations.
3. Update package publishing and Pi extension metadata, TypeScript include paths, schema-generation import, and development documentation.
4. Run formatting, type checking, tests, and package dry-run; fix only move-related breakage.

## Validation
- `pnpm check`
- `npm pack --dry-run`

## Progress
- [x] Recorded the target layout and constraints.
- [x] Moved files and updated references.
- [x] Completed validation.

## Decisions
- The source root is `src/`; `package.json` points Pi directly at `./src/index.ts`.
- `src/usage/coordination/` remains a focused nested module rather than being flattened.

## Outcomes & Retrospective
- Production code now lives under `src/` by domain; tests are co-located and process fixtures live under `test/fixtures/`.
- The published Pi entry is `src/index.ts`; package contents contain runtime source only, not tests.
- `pnpm check` passed with 210 tests. `npm pack --dry-run` verified the package contains the new entry and all runtime modules.
