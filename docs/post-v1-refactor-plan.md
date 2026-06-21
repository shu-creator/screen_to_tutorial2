# Post-v1 Refactor Plan

## Fixed Baseline

- Working branch: `codex/post-v1-refactor`
- Completion baseline tag: `v1.0.0`
- Baseline commit: `e034c9cc3b9938ea91931d2f520f77e79080682c`
- Baseline commit date: `2026-06-21T01:54:30+09:00`
- `v1.0.0` points to the same commit: yes
- Baseline audit command: `pnpm v1:release-audit -- --json`
- Baseline audit status: PASS

Baseline `v1:release-audit` checks:

| Check | Status | Detail |
| --- | --- | --- |
| `release.docs` | PASS | Found `.env.example`, `README.md`, `docs/setup-local.md`, `docs/v1-release-checklist.md`, `docs/roadmap.md`. |
| `model.default` | PASS | `.env.example` keeps `LLM_MODEL=gpt-5.4`. |
| `eval.readiness` | PASS | `real_cases=5/5; warnings=3`. |
| `eval.quality_gate` | PASS | `real_cases=5; G2=69.4%; G3=7.0%`. |
| `smoke.current_environment` | PASS | `outputs/v1-smoke-default-check/v1_smoke_summary.json project=32 steps=3 fallback_reasons=0`. |
| `export.qa` | PASS | Valid export QA cases: `real-app-workflow-04-export-video`, `real-app-workflow-05-narrated-create-project`. |
| `g4.human_review` | PASS | Required real-case human review records exist for `real-app-workflow-04-export-video` and `real-app-workflow-05-narrated-create-project`. |
| `smoke.fresh_environment` | PASS | `outputs/v1-fresh-env-smoke/v1_smoke_summary.json project=34 steps=3 fallback_reasons=0`. |

## Phase Rules

- Keep `v1.0.0` fixed as the completion standard.
- Run the full validation set at the end of each phase:
  - `pnpm check`
  - `pnpm test`
  - `pnpm eval:audit`
  - `pnpm eval:quality-gate`
  - `pnpm v1:release-audit`
- Treat any `pnpm v1:release-audit` regression as a stop signal. Revert the change or isolate it on a separate branch before continuing.
- Do not mix large independent changes in one commit.
- Phase 0 must not delete code or existing docs.

## Known Caveats At Baseline

- `eval.readiness` passes with `warnings=3`; these warnings are part of the fixed v1 baseline and are not by themselves a post-v1 regression.
- `eval.quality_gate` passes at `G2=69.4%` and `G3=7.0%`; post-v1 cleanup must not silently lower these metrics.
- Final release confidence depends on persisted evidence artifacts, not just command exit codes.
- A pipeline run can exit successfully while producing fallback-heavy or partial-failure artifacts. Artifact and log inspection remain required before treating new generated runs as valid.
- `steps.json` is the v1 artifact-first path, but DB step compatibility still exists. Do not change that responsibility split without a separate design pass.

## Phase Scope

### Phase 0: Branch And Baseline

Status: completed.

Allowed change:

- Add this plan document only.

Done condition:

- This document exists.
- No code is deleted.
- Full validation set passes.

Validation result:

- `pnpm check`: PASS
- `pnpm test`: PASS, 24 test files and 261 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=69.4%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

### Phase 1: Inventory

Status: completed.

Targets:

- `scripts/`
- `server/authoring/`
- `server/evidence/`
- `server/videoClips*`
- `server/stepsArtifact*`
- `docs/`
- `eval/`
- `README.md`
- setup docs

Classification buckets:

- `delete_candidate`: unreferenced, obsolete premise, or unnecessary for the v1 path.
- `keep_for_v1`: required by v1 audit, smoke, export, quality gate, or current docs.
- `post_v1_maybe`: likely removable but not yet safe enough to delete.
- `high_risk`: related to DB, artifact sync, export, or evaluation metrics.

Phase 1 output will update this document with:

- deletion candidates
- deferred candidates
- high-risk areas
- safe touch order
- validation commands for each planned change category

Inventory result:

#### `delete_candidate`

| Path | Evidence | Required verification before deletion |
| --- | --- | --- |
| `scripts/requirements.txt` | No package script or runtime reference found. Root `requirements.txt` is the documented Python dependency file and already reflects the post-OpenCV setup. `scripts/requirements.txt` still contains only `opencv-python-headless` and `numpy`, while `docs/plans/phase-5-consolidation.md` says OpenCV/Numpy were refreshed away. | Confirm no external setup docs or shell snippets use this path, then delete in a small Phase 3 commit. Run full phase validation plus `pnpm setup:check`. |

No other file-level delete candidate is safe in Phase 1. Most targeted files are connected to v1 audit, smoke, export, eval, G4 evidence, or artifact compatibility.

#### `keep_for_v1`

| Area | Evidence |
| --- | --- |
| `scripts/v1-smoke.ts`, `scripts/v1-release-audit.ts`, `scripts/v1-fresh-env-smoke.ts` | Package scripts and baseline gates. They validate setup, generation, export content, edit restore, current smoke, fresh-environment smoke, human G4, and fallback-free summaries. |
| `scripts/eval-audit.ts`, `scripts/eval-quality-gate.ts` | Package scripts; `v1-release-audit` imports both. These enforce real-case readiness, required scenario tags, G2/G3 non-regression, and `fallback:*` absence. |
| `scripts/export-project.ts`, `scripts/edit-artifact-smoke.ts` | Used by `v1:smoke` and release evidence. They validate export summaries and DB/artifact edit synchronization. |
| `scripts/export-eval-case.ts`, `scripts/g4-record.ts`, `scripts/g4-review-pack.ts` | Required for Sprint 4 export QA and human G4 workflow. Tests cover record safety and review candidate selection. |
| `scripts/model-rematch.ts` | Current rematch workbench. Tests cover fallback-heavy runs, zero-step runs, 520/429/quota signals, and timeout detection. |
| `server/authoring/` | Imported by `server/stepGenerator.ts` for evidence-driven authoring. Tests cover chunk failure fallback, unassigned segments, UI label verification, low confidence, and waiting-only handling. |
| `server/evidence/` | Imported by `videoProcessor`, `stepGenerator`, `videoGenerator`, and `evidence:extract`. Tests cover segmentation, extraction helpers, and integration. |
| `README.md`, `docs/setup-local.md`, `docs/v1-release-checklist.md`, `docs/roadmap.md`, `eval/README.md` | Release docs and setup/eval source of truth for current CLI. `v1-release-audit` checks the release doc set. |
| `eval/baseline.json`, `eval/dataset/*/{meta.json,ground_truth.json}`, `eval/g4/README.md`, `eval/g4/records/*.json` | Required by `eval:audit`, `eval:quality-gate`, and release audit. G4 records contain release evidence. |

#### `post_v1_maybe`

| Area | Why deferred |
| --- | --- |
| `scripts/ocr_server.py` | No package script directly invokes it, but `server/_core/ocrEngine.ts` spawns it for `OCR_PROVIDER=engine`. Defer unless local OCR engine support is intentionally dropped or moved. |
| Legacy scene-detection fallback in `server/videoProcessor.ts` | Phase docs and `docs/v1-release-checklist.md` say it is retained through v1 and should only be removed after post-v1 real-recording QA. |
| Legacy single-frame analysis path in `server/stepGenerator.ts` | Used when `evidence.json` is missing and can emit `fallback:legacy_step_analysis_failed`. Defer until Phase 4 fallback policy decides whether this fallback remains allowed. |
| `docs/plans/phase-0-eval-harness.md` | Contains stale "real data waiting" and one-real-case language. Keep as history, but move stale claims into `Historical Notes` in Phase 2. |
| `docs/plans/phase-2-step-authoring.md` | Contains stale "real LLM/G1-G3 measurement waiting" language. Keep design history, update status in Phase 2. |
| `docs/plans/phase-3-slide-quality.md` | Still frames some heuristics as waiting for real-data evaluation. Reclassify under Phase 4 fallback/heuristic policy. |
| `docs/plans/phase-4-clip-video.md` | Contains likely stale notes about step-level timing/audio UI. Verify against Sprint 3 implementation before editing. |
| `docs/roadmap.md`, `docs/v1-release-checklist.md` local evidence sections | Both still contain earlier `INCOMPLETE` release-audit evidence even though the baseline audit now passes. Update as narrative evidence in Phase 2 without deleting historical context. |
| Ignored `eval/results/` and `outputs/` local artifacts | Release audit and eval gates read some of these local evidence files. They are not tracked, but deleting them would break local audit PASS unless regenerated. Treat cleanup as a separate evidence-retention decision, not dead-code removal. |

#### `high_risk`

| Area | Risk |
| --- | --- |
| `server/stepsArtifact.ts` and `server/stepsArtifact.test.ts` | Central schema, migration, invalidation, artifact-to-DB compatibility, and unknown-version safety layer. Used by routers, step generation, slides, video generation, export, and edit smoke. |
| `server/videoClips.ts` and `server/videoClips.test.ts` | Controls clip planning, audio-mode resolution, silent/original/TTS behavior, warnings, and `still_image_fallback_count`. Export QA and v1 smoke depend on this summary behavior. |
| `server/evidence/artifactStore.ts` | Retry invalidation and parse behavior affect fallback routing. Changes can silently alter evidence/artifact source selection. |
| DB/artifact sync paths in `server/routers.ts`, `server/stepGenerator.ts`, and `scripts/edit-artifact-smoke.ts` | v1 keeps artifact-first plus DB compatibility. Changing this belongs to Phase 5 design or Phase 6 separate branch. |
| Export pipeline: `server/slideGenerator.ts`, `server/videoGenerator.ts`, `scripts/export-project.ts`, `scripts/export-eval-case.ts` | Release audit depends on export QA, slide content checks, and video fallback counts. |
| Eval metrics and evidence: `server/eval/`, `eval/baseline.json`, `eval/g4/records/*.json` | These define the quality gate and human-review release proof. |

Safe touch order:

1. Docs-only stale narrative: `docs/roadmap.md`, `docs/v1-release-checklist.md`.
2. Historical plan docs: `docs/plans/phase-0-eval-harness.md`, `phase-2-step-authoring.md`, `phase-3-slide-quality.md`, `phase-4-clip-video.md`.
3. Setup-only cleanup: `scripts/requirements.txt`.
4. Non-runtime helper scripts with focused tests: G4/review helpers and eval audit helpers.
5. Smoke/audit scripts, only while preserving artifact/log validation semantics.
6. Authoring/evidence internals, only with focused tests plus the quality gate.
7. `stepsArtifact`, DB sync, video clip, and export paths last; prefer separate design or branch if behavior changes.

Validation matrix:

| Change category | Commands |
| --- | --- |
| End of every phase | `pnpm check`; `pnpm test`; `pnpm eval:audit`; `pnpm eval:quality-gate`; `pnpm v1:release-audit` |
| Docs/setup cleanup | Required phase commands plus `pnpm setup:check` |
| Runtime cleanup near fallback/artifacts/export | Required phase commands plus `pnpm v1:smoke -- --video eval/dataset/synth-login-click-01/video.mp4 --outdir outputs/v1-smoke-default-check --use-audio false --asr-provider none --audio-mode silent --max-frames 12`; inspect summary fields, not exit code alone |
| G4/export QA flow changes | Required phase commands plus `pnpm g4:review-pack -- --release-candidates --overwrite` when review packet behavior changes |

Validation result:

- `pnpm check`: PASS
- `pnpm test`: PASS, 24 test files and 261 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=69.4%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

### Phase 2: Docs Cleanup

Status: completed.

Use `docs/v1-release-checklist.md` as the source of truth for v1 facts. Move historical material into a `Historical Notes` section when it should be retained.

Changes completed:

- Updated `docs/roadmap.md` so the final v1 baseline is PASS at `v1.0.0`, while the earlier `INCOMPLETE` audit remains marked as an initial run.
- Added final v1 baseline evidence to `docs/v1-release-checklist.md` and renamed the earlier smoke section as historical evidence.
- Moved stale "real data waiting" notes in `docs/plans/phase-0-eval-harness.md` into `Historical Notes`.
- Updated `docs/plans/phase-2-step-authoring.md` to reflect v1 quality-gate PASS while leaving confidence calibration as post-v1 work.
- Reworded `docs/plans/phase-3-slide-quality.md` and `docs/plans/phase-4-clip-video.md` so post-v1 heuristic/audio QA status is not confused with pre-v1 incompletion.

Validation result:

- `pnpm setup:check`: PASS
- `pnpm check`: PASS
- `pnpm test`: PASS, 24 test files and 261 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=69.4%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

### Phase 3: Unused Code Removal

Status: pending.

Only delete code after `rg` reference checks and test coverage checks. Avoid steps artifact, DB sync, export pipeline, evidence segmentation core, and eval metrics unless a later design pass explicitly opens them.

### Phase 4: Fallback And Heuristic Policy

Status: pending.

Define allowed and forbidden fallback reasons for post-v1. Strengthen `eval:quality-gate` only if current gates cannot detect forbidden fallback paths.

### Phase 5: Artifact And DB Responsibility Design

Status: pending.

Design only. Enumerate read paths, write paths, UI edit persistence, export reads, and edit smoke guarantees before choosing whether to keep artifact-first plus DB compatibility or move toward `steps.json` as the single source of truth.

### Phase 6: `steps.json` Single Source

Status: deferred.

Recommended separate branch: `codex/post-v1-steps-source`.

### Phase 7: Release Follow-up

Status: deferred.

Track human G4 additions for cases 01/02/03, UI polish, quality prompt improvements, low-G2 case improvements, and a post-v1 checklist.
