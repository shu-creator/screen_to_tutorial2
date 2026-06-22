# Post-v1 Steps Source Completion Audit

## Status

Branch: `codex/post-v1-steps-source-v2`

This is the Phase 6 close-out audit for the artifact-primary `steps.json`
source migration branch. It records what is proven by current code, tests, and
release gates, and what remains out of scope for the later DB-free branch.

## Requirement Evidence

| Requirement | Evidence | Status |
| --- | --- | --- |
| DB step updates remain compatibility-only during this branch. | `server/stepSource.ts` writes `steps.json` first for update/delete/reorder/regenerate, then mirrors DB writes best-effort. Route tests cover DB mirror failures without losing artifact edits. | Met for Phase 6 compatibility scope. |
| Artifact update API is the primary edit path. | `server/routers.ts` routes `step.update`, `step.delete`, `step.reorder`, and `step.regenerate` through `stepSource`; `scripts/edit-artifact-smoke.ts` calls `updateProjectStepArtifactFirst`. `pnpm v1:release-audit` checks these calls through `phase6.source_contract`. | Met. |
| UI reads are artifact-derived while legacy projects stay loadable. | `step.listByProject` and `step.artifactInfo` use `stepSource`. Route/load tests cover existing artifact reads, DB-only compatibility artifact creation, invalid artifact read leniency, and empty compatibility metadata. | Met with DB compatibility fallback retained. |
| Export/render paths use the same source contract. | Slide generation, video generation, and `scripts/export-project.ts` use `loadProjectStepRenderState`; `phase6.source_contract` fails if these entrypoints drop the adapter. | Met. |
| Edit routes reject malformed artifacts before DB writes. | Route tests cover update/delete/reorder/regenerate invalid-artifact rejection; render/export still keep the documented invalid-artifact DB fallback. | Met. |
| Incomplete `legacy_step_db_id` mappings do not silently fall back to DB writes. | Route tests cover update/delete/reorder/regenerate mismatch rejection, including artifacts that would otherwise match only by `sort_order`. `phase6.source_contract` fails if unmatched edit branches reintroduce DB step writes or if write paths reintroduce a missing-legacy-ID `sort_order` fallback. | Met. |
| Existing DB-only projects are still compatible. | Route tests cover DB-only list, update, delete, reorder, and regenerate promotion to compatibility `steps.json`. | Met for covered route shapes. |
| Edit smoke verifies the artifact-primary adapter. | `pnpm edit:smoke` edits through `updateProjectStepArtifactFirst`, checks `adapter.artifactUpdated` and `adapter.dbUpdated`, verifies DB/artifact sync, restores original values, and is required by `pnpm v1:release-audit` through nested smoke checks. | Met for one selected project step. |
| v1 release audit remains green. | Slice-boundary validation runs `pnpm check`, `pnpm test`, `pnpm eval:audit`, `pnpm eval:quality-gate`, `pnpm v1:release-audit`, plus edit smoke and G4 review-pack dry-run. | Met at each completed Phase 6 slice. |
| Additional tests are present. | `server/stepSource.load.test.ts`, `server/stepSource.test.ts`, `server/stepSource.router.test.ts`, and `server/v1-release-audit.test.ts` cover adapter behavior, route behavior, compatibility promotion, strict edit failures, and audit guardrails. | Met. |

## Remaining Boundaries

These are intentionally not completed on `codex/post-v1-steps-source-v2`:

- Full DB bridge removal. `legacy_step_db_id` remains because existing UI
  mutations and compatibility mirrors still depend on DB step IDs.
- Broad real-project migration sampling beyond the current smoke project and
  fixture-backed route tests.
- Concurrent edit conflict handling across artifact storage and DB mirrors.
- Removing render/export DB fallbacks for missing or malformed artifacts.
- Replacing generation-time DB persistence with artifact-only IDs.

## Close-Out Judgment

Phase 6 has reached the artifact-primary compatibility target described in
`docs/post-v1-steps-source-migration.md` and
`docs/post-v1-artifact-db-responsibility.md`.

The branch has since been fast-forward integrated into `codex/post-v1-refactor`.
The next implementation step should not be more opportunistic compatibility
cleanup. It should be:

- start a separate DB-free branch that removes the `legacy_step_db_id` bridge
  and DB-dependent route addressing in one coordinated design.
