# Post-v1 Artifact And DB Responsibility

## Status

This is the Phase 5 design memo for the post-v1 refactor. It records the current read/write responsibilities and the source-of-truth decision before any implementation work.

Phase 6 branch references were updated after the Phase 7 close-out to avoid
continuing the stale pre-Phase-7 migration branch.

Decision: keep the v1 responsibility split on `codex/post-v1-refactor`.

- v1 remains artifact-first for generated step evidence and export/rendering metadata.
- DB `steps` remains the compatibility layer for the current UI list/edit routes and legacy renderable IDs.
- `steps.json` single-source migration is deferred to a separate branch:
  `codex/post-v1-steps-source-v2`.
  `codex/post-v1-steps-source` predates Phase 7 and must not be merged
  wholesale; see `docs/post-v1-steps-source-migration.md`.

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
| `step.listByProject` in `server/routers.ts` | `stepSource` adapter: `steps.json`, then DB compatibility fallback | Main UI step list is artifact-derived when `steps.json` exists and falls back to DB rows for legacy/missing artifacts. |
| `step.artifactInfo` in `server/routers.ts` | `stepSource` adapter: `steps.json`, then compatibility empty metadata | Provides overview, review state, warnings, confidence, timing, and audio mode keyed by `legacy_step_db_id`. Compatibility artifacts and missing artifacts return empty metadata. |
| `server/slideGenerator.ts` | `stepSource` render state: `steps.json`, then DB compatibility fallback | Builds renderable steps from artifact when available. Missing artifacts can be promoted from DB; malformed artifacts can render from DB without mutation. |
| `server/videoGenerator.ts` renderable step loading | `stepSource` render state: `steps.json`, then DB compatibility fallback | Uses artifact when available. Audio generation may replace a malformed artifact with a DB compatibility artifact before patching generated audio references. |
| `server/videoGenerator.ts` clip/audio rendering | `steps.json` plus `evidence.json`, with DB-backed renderable IDs | Uses artifact timing, audio mode, and source segment IDs for clip planning. |
| `scripts/export-project.ts` content checks | `stepSource` render state: `steps.json`, then DB compatibility fallback | Expected step-image count comes from the same render state used by project export paths. |
| `server/cli/generatePipeline.ts` | `steps.json` after generation | Fails if the generated artifact is missing. |
| `scripts/export-eval-case.ts` | eval case artifacts | Standalone eval export does not depend on project DB rows. |
| v1 smoke and release audit | generated summaries and artifacts | Release validity depends on persisted artifact evidence, not command exit codes alone. |

## Write Paths

| Path | Current write behavior | Risk if changed |
| --- | --- | --- |
| `generateStepsFromEvidence` in `server/stepGenerator.ts` | Builds `StepsArtifact`, persists DB rows through `persistStepsToDb`, injects `legacy_step_db_id`, then saves `steps.json`. | Removing DB persistence before replacing legacy IDs breaks compatibility mirrors and older project handling. |
| Legacy single-frame generation in `server/stepGenerator.ts` | Also persists DB rows and saves artifact. | This is a fallback path; changing it belongs with fallback-policy work and real-case QA. |
| `persistStepsToDb` in `server/stepGenerator.ts` | Deletes existing DB steps and recreates them from artifact content. | Step IDs can change; artifact must be saved with the new `legacy_step_db_id` values. |
| Project retry in `server/routers.ts` | Deletes DB frames/steps and invalidates `steps.json` and `evidence.json`. | Old artifacts can reference deleted frames if invalidation is removed. |
| `step.update` in `server/routers.ts` | Patches artifact first, then mirrors DB text fields when possible. Artifact-only fields require an artifact. | The artifact save is the primary commit point; a DB mirror failure can leave compatibility rows stale while artifact reads remain current. |
| `step.delete` in `server/routers.ts` | Deletes from artifact first, then mirrors DB delete/order compaction when possible. | A DB mirror failure can leave compatibility rows stale while artifact reads remain current. |
| `step.regenerate` in `server/routers.ts` | Analyzes the selected frame, patches matching artifact fields first, then mirrors regenerated text/frame fields to DB when possible. | A DB mirror failure can leave compatibility rows stale while artifact reads remain current. |
| `step.reorder` in `server/routers.ts` | Reorders artifact by `legacy_step_db_id` first, then mirrors DB row order when possible. | A DB mirror failure can leave compatibility rows stale while artifact reads remain current. |
| Audio generation in `server/videoGenerator.ts` | Writes audio references to DB-compatible steps and patches artifact audio fields and warnings. | Export/video paths need both compatibility and artifact warning visibility through v1. |
| `scripts/edit-artifact-smoke.ts` | Temporarily edits through the artifact-primary step adapter, verifies adapter result plus DB/artifact sync, then restores both by re-read. | This is the current guardrail for the Phase 6 source contract. |

## UI Edit Persistence

The current UI edit model is artifact-primary with a compatibility DB mirror:

- Text fields (`title`, `operation`, `description`, `narration`) are saved to `steps.json` first and mirrored to DB when possible.
- Artifact-only fields (`tStart`, `tEnd`, `audioMode`, `markReviewed`) are saved only to `steps.json`.
- Artifact-only updates fail when `steps.json` is missing.
- `markReviewed` clears `needs_review`, `review_reasons`, and `warnings` in the artifact.
- Delete/reorder/regenerate use artifact-first writes keyed by `legacy_step_db_id`, with DB updates retained as compatibility mirrors.

This means the Phase 6 UI is artifact-primary but not yet DB-free. DB rows are still required as the compatibility ID bridge for existing routes and older projects.

The current route is not an atomic transaction across storage and DB. `step.update` saves the artifact before updating DB text fields; the intended consistency rule is that artifact state wins and DB mirror failures are logged.

## Export And Render Behavior

Slides, video, and project export prefer artifact data when it exists:

- slide generation renders from artifact steps and uses artifact overview/review metadata for v2 quality features.
- video generation uses artifact step timing, audio mode, and source-segment links for clip planning.
- project export uses artifact step count for content inspection when possible.

The DB fallback remains a compatibility mechanism for existing projects and missing artifacts. It should not be removed on the post-v1 refactor branch because it is part of the release audit safety net.

## Current Smoke Guarantees

`scripts/edit-artifact-smoke.ts` guarantees the following for one selected project step:

- The artifact-primary step adapter reports artifact and DB mirror updates.
- DB text fields can be edited through the adapter mirror.
- Matching artifact fields can be edited through the adapter.
- artifact timing and audio mode can be edited.
- review state can be cleared.
- original DB and artifact values are restored and re-read after the smoke.

It does not fully prove:

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
