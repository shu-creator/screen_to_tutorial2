# Post-v1 Artifact And DB Responsibility

## Status

This is the Phase 5 design memo for the post-v1 refactor. It records the current read/write responsibilities and the source-of-truth decision before any implementation work.

Decision: keep the v1 responsibility split on `codex/post-v1-refactor`.

- v1 remains artifact-first for generated step evidence and export/rendering metadata.
- DB `steps` remains the compatibility layer for the current UI list/edit routes and legacy renderable IDs.
- `steps.json` single-source migration is deferred to a separate branch, recommended as `codex/post-v1-steps-source`.

## Current Data Responsibilities

`steps.json` v2 is the rich generated artifact. It carries:

- `overview`
- ordered step content
- `t_start` / `t_end`
- representative frames
- changed-region metadata
- evidence links through `source_segment_ids`
- verification signals: `needs_review`, `review_reasons`, `warnings`, `confidence`
- `audio_mode`, `audio_url`, `audio_key`
- `legacy_step_db_id` as the bridge back to DB rows

DB `steps` remains the UI and compatibility record. It carries the stable database ID plus the legacy fields needed by existing routes:

- `projectId`
- `frameId`
- `title`
- `operation`
- `description`
- `narration`
- `sortOrder`
- generated audio references when audio generation writes them

The bridge is `legacy_step_db_id`. Any source-of-truth change must either preserve this bridge during migration or remove all routes that depend on DB IDs at the same time.

## Read Paths

| Path | Current source order | Notes |
| --- | --- | --- |
| `step.listByProject` in `server/routers.ts` | DB only | Main UI step list still reads DB rows. |
| `step.artifactInfo` in `server/routers.ts` | `steps.json` | Provides overview, review state, warnings, confidence, timing, and audio mode keyed by `legacy_step_db_id`. Missing artifact returns empty metadata. |
| `server/slideGenerator.ts` | DB seed, then `steps.json` if present | Builds renderable steps from artifact when available. If artifact is missing but DB steps exist, it writes a compatibility artifact from DB. |
| `server/videoGenerator.ts` renderable step loading | DB seed, then `steps.json` if present | Uses artifact when available and writes a compatibility artifact from DB if needed. |
| `server/videoGenerator.ts` clip/audio rendering | `steps.json` plus `evidence.json`, with DB-backed renderable IDs | Uses artifact timing, audio mode, and source segment IDs for clip planning. |
| `scripts/export-project.ts` content checks | `steps.json`, then DB fallback | Expected step-image count comes from artifact when possible. Falling back to DB adds a warning. |
| `server/cli/generatePipeline.ts` | `steps.json` after generation | Fails if the generated artifact is missing. |
| `scripts/export-eval-case.ts` | eval case artifacts | Standalone eval export does not depend on project DB rows. |
| v1 smoke and release audit | generated summaries and artifacts | Release validity depends on persisted artifact evidence, not command exit codes alone. |

## Write Paths

| Path | Current write behavior | Risk if changed |
| --- | --- | --- |
| `generateStepsFromEvidence` in `server/stepGenerator.ts` | Builds `StepsArtifact`, persists DB rows through `persistStepsToDb`, injects `legacy_step_db_id`, then saves `steps.json`. | Removing DB persistence breaks current UI list/edit routes. |
| Legacy single-frame generation in `server/stepGenerator.ts` | Also persists DB rows and saves artifact. | This is a fallback path; changing it belongs with fallback-policy work and real-case QA. |
| `persistStepsToDb` in `server/stepGenerator.ts` | Deletes existing DB steps and recreates them from artifact content. | Step IDs can change; artifact must be saved with the new `legacy_step_db_id` values. |
| Project retry in `server/routers.ts` | Deletes DB frames/steps and invalidates `steps.json` and `evidence.json`. | Old artifacts can reference deleted frames if invalidation is removed. |
| `step.update` in `server/routers.ts` | Patches artifact first, then writes DB text fields. Artifact-only fields require an artifact. | Partial migration can create DB/artifact divergence or make timing/audio edits impossible. The current dual-write is not atomic: a DB failure after artifact save can leave the two stores out of sync. |
| `step.delete` in `server/routers.ts` | Deletes DB row, reorders DB rows, then patches artifact only if every remaining DB row maps back to artifact. | Missing bridges leave artifact unchanged by design. |
| `step.regenerate` in `server/routers.ts` | Runs legacy DB regeneration, then patches matching artifact fields. | Artifact metadata can become stale if the patch path is removed. |
| `step.reorder` in `server/routers.ts` | Reorders DB rows, then reorders artifact by `legacy_step_db_id` if mapping is complete. | UI order and artifact order can diverge. |
| Audio generation in `server/videoGenerator.ts` | Writes audio references to DB-compatible steps and patches artifact audio fields and warnings. | Export/video paths need both compatibility and artifact warning visibility through v1. |
| `scripts/edit-artifact-smoke.ts` | Temporarily edits DB and artifact, verifies both, then restores both by re-read. | This is the current guardrail for DB/artifact edit synchronization. |

## UI Edit Persistence

The current UI edit model is intentionally dual-write:

- Text fields (`title`, `operation`, `description`, `narration`) are saved to DB and mirrored to `steps.json` when the artifact exists.
- Artifact-only fields (`tStart`, `tEnd`, `audioMode`, `markReviewed`) are saved only to `steps.json`.
- Artifact-only updates fail when `steps.json` is missing.
- `markReviewed` clears `needs_review`, `review_reasons`, and `warnings` in the artifact.
- Delete/reorder/regenerate still start from DB IDs and then patch artifact by `legacy_step_db_id`.

This means the v1 UI is not yet `steps.json` single-source. It is artifact-enriched DB editing.

The current route is also not an atomic transaction across storage and DB. `step.update` saves the artifact before updating DB text fields, so Phase 6 should either collapse edits to a single writer or add explicit recovery/consistency handling.

## Export And Render Behavior

Slides and video already prefer artifact data when it exists:

- slide generation renders from artifact steps and uses artifact overview/review metadata for v2 quality features.
- video generation uses artifact step timing, audio mode, and source-segment links for clip planning.
- project export uses artifact step count for content inspection when possible.

The DB fallback remains a compatibility mechanism for existing projects and missing artifacts. It should not be removed on the post-v1 refactor branch because it is part of the release audit safety net.

## Current Smoke Guarantees

`scripts/edit-artifact-smoke.ts` guarantees the following for one selected project step:

- DB text fields can be edited.
- Matching artifact fields can be edited.
- artifact timing and audio mode can be edited.
- review state can be cleared.
- original DB and artifact values are restored and re-read after the smoke.

It does not fully prove:

- the tRPC/UI `step.update` route itself;
- every delete/reorder/regenerate edge case;
- behavior when `legacy_step_db_id` mapping is incomplete;
- concurrent edits;
- migration safety for older projects with DB-only steps;
- a UI list that reads directly from `steps.json`.

Those gaps are acceptable for v1 compatibility, but they are required test targets before single-source migration.

## Decision

Use the v1-maintaining option for this branch:

- Keep artifact-first generation/export/rendering.
- Keep DB compatibility and dual-write UI edits.
- Do not remove `stepsArtifact`, DB sync, export fallback, or edit-smoke compatibility paths in Phase 5.
- Treat `steps.json` single-source migration as Phase 6 work on a separate branch.

## Phase 6 Opening Criteria

Before implementing single-source migration, create a separate branch and expand tests around these behaviors:

- UI list reads from `steps.json` or a single artifact-derived adapter.
- Existing DB-only projects still open through migration or explicit compatibility fallback.
- Edit, delete, reorder, regenerate, audio generation, slide export, video export, and edit smoke all use the same source-of-truth contract.
- `legacy_step_db_id` is either preserved as a compatibility bridge or removed only after all DB-ID-dependent routes are migrated.
- `pnpm check`, `pnpm test`, `pnpm eval:audit`, `pnpm eval:quality-gate`, `pnpm v1:release-audit`, and an explicit edit smoke all pass.
