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

Status: completed.

Only delete code after `rg` reference checks and test coverage checks. Avoid steps artifact, DB sync, export pipeline, evidence segmentation core, and eval metrics unless a later design pass explicitly opens them.

Changes:

- Deleted `scripts/requirements.txt`, an unreferenced stale Python dependency file that still listed `opencv-python-headless` and `numpy`.
- Kept root `requirements.txt` as the documented Python dependency source for dataset generation and optional OCR engine setup.
- Did not touch steps artifact, DB sync, export pipeline, evidence segmentation core, eval metrics, legacy fallback paths, or slide heuristics.

Validation result:

- `pnpm setup:check`: PASS
- `pnpm check`: PASS
- `pnpm test`: PASS, 24 test files and 261 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=69.4%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

### Phase 4: Fallback And Heuristic Policy

Status: completed.

Define allowed and forbidden fallback reasons for post-v1. Strengthen `eval:quality-gate` only if current gates cannot detect forbidden fallback paths.

Output:

- `docs/post-v1-fallback-policy.md`

Decision:

- No `eval:quality-gate` implementation change is needed in Phase 4. It already detects `fallback:*` review reasons in real-case generated artifacts.
- Video/export fallback signals are intentionally covered by `pnpm v1:smoke`, export QA, and `pnpm v1:release-audit`, not by the eval metric gate.

Validation result:

- `pnpm check`: PASS
- `pnpm test`: PASS, 24 test files and 261 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=69.4%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

### Phase 5: Artifact And DB Responsibility Design

Status: completed.

Design only. Enumerate read paths, write paths, UI edit persistence, export reads, and edit smoke guarantees before choosing whether to keep artifact-first plus DB compatibility or move toward `steps.json` as the single source of truth.

Output:

- `docs/post-v1-artifact-db-responsibility.md`

Decision:

- Keep the v1 split on this branch: artifact-first generation/export/rendering plus DB compatibility for current UI list/edit routes.
- Do not implement `steps.json` single-source migration on `codex/post-v1-refactor`.
- Move single-source migration to a separate Phase 6 branch after expanding edit/delete/reorder/regenerate/export compatibility tests.

Current source-of-truth map:

- `steps.json` v2 owns rich generated metadata: overview, timing, representative frames, evidence links, review reasons, warnings, confidence, audio mode, and artifact audio references.
- DB `steps` owns current UI list compatibility and legacy DB IDs.
- `legacy_step_db_id` bridges the two layers.
- Slide generation, video generation, CLI pipeline export, and project export prefer artifact data where possible.
- UI list/edit routes still depend on DB rows, with artifact metadata layered in through `step.artifactInfo` and `step.update` dual-write behavior.
- `step.update` dual-write is not atomic across artifact storage and DB; Phase 6 must either collapse edits to one writer or add consistency recovery.
- Edit smoke verifies DB/artifact storage sync, artifact timing/audio-mode edits, review-state clearing, and restoration by re-read, but it does not exercise the tRPC/UI `step.update` route or every delete/reorder/regenerate/migration edge case.

Validation result:

- `pnpm check`: PASS
- `pnpm test`: PASS, 24 test files and 261 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=69.4%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

### Phase 6: `steps.json` Single Source

Status: deferred.

Recommended separate branch: `codex/post-v1-steps-source`.

Opening criteria:

- Keep existing DB-only projects loadable through migration or explicit compatibility fallback.
- Move UI list/read/edit paths to one artifact-derived contract.
- Define whether `legacy_step_db_id` remains as a bridge or is removed after all DB-ID-dependent routes move.
- Add tests for tRPC/UI edit, delete, reorder, regenerate, audio generation, slide export, video export, and edit smoke under the new source-of-truth contract.

### Phase 7: Release Follow-up

Status: mostly complete on `codex/post-v1-refactor`. The explicit-approval
`authoring-v2-grounded-3` regeneration measurement has been run locally and
passed the machine promotion gate; tracked artifact promotion remains a separate
human-review decision.

Output:

- `docs/post-v1-checklist.md`
- `outputs/g4-review-packets/real-app-workflow-01.md` (ignored local review packet)
- `outputs/g4-review-packets/real-app-workflow-02-create-project.md` (ignored local review packet)
- `outputs/g4-review-packets/real-app-workflow-03-generate-steps.md` (ignored local review packet)

Completed or started changes:

- Generated G4 human-review packets for cases 01/02/03.
- Replaced 01/02/03 `eval/g4/records/*.json` with `human_review` records
  after explicit human confirmation from `iwsh23`: reviewed_at `2026-06-21`,
  all edit counts `0`, and no blocking issues.
- Added `docs/post-v1-checklist.md` with the human G4 workflow, low-G2 case order, prompt-regeneration path, UI polish queue, and close-out gates.
- Updated the authoring prompt to `authoring-v2-grounded-3` so future generation keeps distinct user intents separate, avoids OCR-unsupported UI label citations, and excludes state/result-only labels from `cited_ui_labels`.
- Added `pnpm eval:candidate` to score a candidate `steps.json` against `eval/baseline.json` without replacing tracked generated artifacts.
- Polished project step cards with clearer review metadata for timing range, confidence, audio mode, narration, and edit/delete controls.
- Kept project step edit forms open after individual blur-save updates, so
  human reviewers can make several corrections before closing a card.
- Suppressed no-op blur saves and reset cleared timing fields to the current
  artifact value to keep persistent edit forms visually aligned with saved state.
- Hardened evidence frame extraction near the end of videos and normalized cited UI labels with outer quotes / dynamic count suffixes, then measured `real-app-workflow-03-generate-steps` as a local `authoring-v2-grounded-2` candidate: G2 `71.4%`, G3 `0.0%`, fallback reasons `0`.
- Rechecked the tracked generated artifacts with the post-v1 label normalizer:
  current branch quality gate is G2 `82.8%`, G3 `7.0%`, fallback reasons `0`.
- Kept the earlier case 03 candidate local because it improves G3 (`25.0%` to
  `0.0%`) but scores lower G2 than the current tracked case 03 artifact under
  the same normalizer (`71.4%` vs `75.0%`).
- Added a no-write `pnpm pipeline:generate -- --preflight` path so low-G2
  current-prompt measurement can be planned before DB/storage/output writes.
- Changed `pnpm g4:review-pack -- --missing-human-review --dry-run` so an
  empty selection is a successful close-out no-op after all real cases have
  `human_review` records. Empty `--release-candidates` remains a failure.
- After explicit side-effect approval, regenerated case 03 with
  `authoring-v2-grounded-3` as
  `outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-approved-20260621T220758/project_40_steps.json`.
  The candidate passed `pnpm eval:candidate -- --post-v1-promotion-gate --details`
  with G2 `100.0%`, G3 `0.0%`, no no-citation regression, no unmatched labels,
  no fallback reasons, and prompt version `authoring-v2-grounded-3`.

Still open:

- Artifact sync status UI remains queued until the Phase 6 artifact-first route is merged.
- The measured `authoring-v2-grounded-3` case 03 candidate
  (`project_40_steps.json`) has not been copied into
  `eval/results/generated/*` or `eval/baseline.json`.
- Promoting `project_40_steps.json` would change the artifact covered by the
  existing case 03 `human_review` G4 record, so artifact replacement requires an
  explicit promotion decision plus refreshed human review evidence for the
  promoted artifact.

Operational guardrail for future measurement reruns:

- Use `pnpm post-v1:prompt-check` as the default no-write runner. It prints the
  preflight, execution, side-effect, and promotion-gate plan; `--execute` is
  rejected unless paired with `--accept-side-effects`. The printed
  promotion-gate path is a `project_<project-id>_steps.json` template for manual
  replacement; execute mode resolves the actual generated artifact
  automatically.

Current candidate guardrails:

- `eval:candidate -- --require-g2-improvement` compares against
  `eval/baseline.json`, which still records the fixed v1 case 03 G2 `41.7%`;
  it is not a substitute for comparing a candidate against the current tracked
  artifact score of G2 `75.0%` under the post-v1 normalizer.
- `pnpm eval:candidate -- --require-g2-improvement` now provides the
  fixed-baseline comparison gate; accepting a regenerated low-G2 artifact still
  requires comparing it with the current tracked artifact and reviewing the
  G2/G3 tradeoff.
- `pnpm eval:candidate -- --case <case-id> --steps <steps-path> --post-v1-promotion-gate`
  is available as the combined future candidate promotion check. It compares
  with the current generated artifact, requires fixed-baseline G2 improvement,
  allows no current G2 or no-citation regression, and requires current G3
  improvement. It also requires candidate `config.prompt_version` to match the
  active authoring prompt version.
- `--details` prints candidate G2 cited-label diagnostics when a
  candidate fails or when low-G2 cases need label-level triage.

Validation result for the Phase 7 starter slice:

- `pnpm check`: PASS
- `pnpm test`: PASS, 25 test files and 266 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=69.4%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

- Additional G4 packet validation: `pnpm g4:review-pack -- --case real-app-workflow-01 --case real-app-workflow-02-create-project --case real-app-workflow-03-generate-steps --overwrite` PASS.
- Additional low-G2 candidate validation: `pnpm eval:candidate -- --case real-app-workflow-03-generate-steps --steps eval/results/generated/real-app-workflow-03-generate-steps/steps.json` PASS, G2=41.7%, G3=25.0%, fallback=0. `--case ..` is rejected before dataset path resolution.

Validation result for the Phase 7 low-G2 candidate slice:

- `pnpm check`: PASS
- `pnpm test`: PASS, 26 test files and 275 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

- Additional candidate validation: `pnpm eval:candidate -- --case real-app-workflow-03-generate-steps --steps outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-20260621T0902/project_39_steps.json --require-g2-improvement` PASS, G2=71.4%, G3=0.0%, fallback=0.

Validation result for the Phase 7 G4 selector slice:

- `pnpm check`: PASS
- `pnpm test`: PASS, 26 test files and 285 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.
- Additional G4 selector validation: `pnpm vitest run server/g4-review-pack.test.ts` PASS, 9 tests. `pnpm g4:review-pack -- --missing-human-review --overwrite` regenerated packets for `real-app-workflow-01`, `real-app-workflow-02-create-project`, and `real-app-workflow-03-generate-steps`.

Validation result for the Phase 7 UI edit polish slice:

- `pnpm check`: PASS
- `pnpm test`: PASS, 26 test files and 285 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

Validation result for the Phase 7 current-G3 candidate gate slice:

- `pnpm check`: PASS
- `pnpm test`: PASS, 26 test files and 289 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.
- Additional candidate-gate validation: `pnpm vitest run server/eval-candidate.test.ts` PASS, 17 tests. Existing case 03 prompt candidate with `--current-generated --max-current-g2-regression 0 --require-current-g3-improvement --require-g2-improvement` fails as expected with `current_g2_regression` while reporting G3 improvement from `25.0%` to `0.0%`.

Validation result for the Phase 7 current no-citation candidate gate slice:

- `pnpm check`: PASS
- `pnpm test`: PASS, 26 test files and 294 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.
- Additional candidate-gate validation: `pnpm vitest run server/eval-candidate.test.ts` PASS, 22 tests. Existing case 03 prompt candidate with `--current-generated --max-current-g2-regression 0 --max-current-no-citation-regression 0 --require-current-g3-improvement --require-g2-improvement` fails as expected with `current_g2_regression` while reporting no no-citation regression and G3 improvement from `25.0%` to `0.0%`.

Validation result for the Phase 7 post-v1 promotion gate preset slice:

- Added `pnpm eval:candidate -- --post-v1-promotion-gate` as the combined
  strict candidate promotion preset.
- The preset defaults to comparing against `eval/results/generated/<case-id>/steps.json`
  when no explicit `--current-steps` is supplied.
- It requires fixed-baseline G2 improvement, allows no current G2 regression,
  allows no current no-citation-rate regression, and requires current G3
  improvement.
- `pnpm vitest run server/eval-candidate.test.ts`: PASS, 27 tests.
- Existing case 03 prompt candidate with `--post-v1-promotion-gate` fails as
  expected with `current_g2_regression` while reporting no no-citation
  regression and G3 improvement from `25.0%` to `0.0%`.
- `pnpm check`: PASS
- `pnpm test`: PASS, 26 test files and 299 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

Validation result for the Phase 7 candidate G2 diagnostics slice:

- Added `pnpm eval:candidate -- --details` to print the allowed UI labels,
  unmatched cited labels, and steps with no citations for a candidate artifact.
- This is diagnostic only; it does not change pass/fail thresholds, generated
  artifacts, G4 records, or `eval/baseline.json`.
- `pnpm vitest run server/eval-candidate.test.ts`: PASS, 30 tests.
- Existing case 03 prompt candidate with `--post-v1-promotion-gate --details`
  still fails as expected with `current_g2_regression`; the new details report
  unmatched cited labels `プレビュー`, `完了`, `ステップがありません`, and
  `ステップの生成を開始しました`, plus `G2 no-citation steps: none`.
- `pnpm check`: PASS
- `pnpm test`: PASS, 26 test files and 302 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

Validation result for the Phase 7 state-label prompt guard slice:

- Bumped `AUTHORING_PROMPT_VERSION` to `authoring-v2-grounded-3`.
- Added prompt guidance that state/result-only text such as `プレビュー`, `完了`,
  `ステップがありません`, and `ステップの生成を開始しました` should not enter
  `cited_ui_labels` unless the step explicitly confirms that text.
- This is prompt-only; no generated artifacts, G4 records, or
  `eval/baseline.json` were updated.
- `pnpm vitest run server/authoring/author.test.ts`: PASS, 10 tests.
- `pnpm check`: PASS
- `pnpm test`: PASS, 26 test files and 302 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

Validation result for the Phase 7 candidate prompt-version diagnostics slice:

- Added candidate and current generated artifact `config.prompt_version` reporting to
  `pnpm eval:candidate` text and JSON output.
- This keeps old prompt candidates visible during post-v1 promotion checks; it
  does not change pass/fail thresholds, generated artifacts, G4 records, or
  `eval/baseline.json`.
- `pnpm vitest run server/eval-candidate.test.ts`: PASS, 31 tests.
- Existing case 03 prompt candidate with `--post-v1-promotion-gate --details`
  still fails as expected with `current_g2_regression` while reporting candidate
  prompt version `authoring-v2-grounded-2` and current artifact prompt version
  `authoring-v2-grounded-1`.
- Independent review found no critical or major findings; adopted minor fixes for
  prompt-version trimming, clearer current-artifact wording, and legacy artifact
  test coverage.
- `pnpm eval:candidate -- --case real-app-workflow-03-generate-steps --steps outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-20260621T0902/project_39_steps.json --current-generated --json`: PASS and includes `promptVersion` / `currentPromptVersion`.
- `pnpm check`: PASS
- `pnpm test`: PASS, 26 test files and 303 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

Validation result for the Phase 7 candidate prompt-version gate slice:

- Moved `AUTHORING_PROMPT_VERSION` to a lightweight authoring prompt-version
  module while preserving the existing `server/authoring/author.ts` export.
- Tightened `pnpm eval:candidate -- --post-v1-promotion-gate` so candidate
  `config.prompt_version` must match the active authoring prompt version.
- This blocks stale prompt candidates from promotion without changing ordinary
  candidate diagnostics, generated artifacts, G4 records, or `eval/baseline.json`.
- `pnpm vitest run server/eval-candidate.test.ts server/authoring/author.test.ts`: PASS, 43 tests.
- Existing case 03 prompt candidate with `--post-v1-promotion-gate --details`
  still fails as expected while now reporting `prompt_version_mismatch`,
  required prompt version `authoring-v2-grounded-3`, and current-artifact
  G2 regression.
- Independent review found no critical or major findings; adopted minor fixes
  for idiomatic prompt-version export and keeping the required prompt version
  as an internal post-v1 gate condition instead of a public option.
- `pnpm check`: PASS
- `pnpm test`: PASS, 26 test files and 305 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

Validation result for the Phase 7 G4 review-pack dry-run slice:

- Added `pnpm g4:review-pack -- --dry-run` so human-review worksheet selection
  can be previewed without writing packet files or G4 records.
- Documented the dry-run-first workflow for `--missing-human-review`.
- Independent review found no critical or major findings; added direct coverage
  for the dry-run no-write contract after review.
- `pnpm vitest run server/g4-review-pack.test.ts`: PASS, 11 tests.
- `pnpm g4:review-pack -- --missing-human-review --dry-run`: PASS; selected
  `real-app-workflow-01`, `real-app-workflow-02-create-project`, and
  `real-app-workflow-03-generate-steps`.
- `pnpm check`: PASS
- `pnpm test`: PASS, 26 test files and 307 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, baseline warnings=3.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS.

Phase 7 next slice: add a no-write preflight mode to `pnpm pipeline:generate`
before measuring current-prompt low-G2 candidates. Existing `--dry-run` creates
the output directory, creates the CLI local user/project, and stores the source
video before skipping processing, so it is unsuitable as the approval-free
planning step for prompt impact measurement. Keep `--dry-run` behavior for
compatibility, add `--preflight` that exits before outdir/DB/storage/output
writes, document the preflight-first workflow, and verify with the standard
phase gate commands.

Validation result for the Phase 7 pipeline preflight and human G4 slice:

- Added `pnpm pipeline:generate -- --preflight` as a no-write planning check
  that exits before outdir creation, DB user/project writes, source video
  storage, evidence processing, and `project_*_steps.json` export.
- Preserved existing `--dry-run` behavior for compatibility and documented that
  it still creates outdir, DB user/project state, and source video storage
  before skipping processing.
- Added CLI helper and command-level tests for preflight parsing, plan output,
  and the no-outdir-write boundary.
- Replaced the ai-estimate G4 records for `real-app-workflow-01`,
  `real-app-workflow-02-create-project`, and
  `real-app-workflow-03-generate-steps` with human_review records after user
  confirmation. Reviewer `iwsh23`, reviewed_at `2026-06-21`, all edit counts
  `0`, and no blocking issues.
- `pnpm g4:record -- ... --dry-run`: PASS for all three cases before
  `--overwrite`.
- `pnpm vitest run server/cli/generatePipeline.test.ts`: PASS, 3 tests.
- `pnpm pipeline:generate -- --video eval/dataset/real-app-workflow-03-generate-steps/video.mp4 --outdir outputs/post-v1-prompt-check/preflight-smoke --use-audio false --asr-provider none --preflight`: PASS.
- Independent review found no critical or major findings. Adopted minor fixes
  for preflight `PASS` semantics, `--dry-run` outdir documentation, and the ESM
  main guard.
- `pnpm check`: PASS
- `pnpm test`: PASS, 27 test files and 310 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases, no G4 warnings.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS; required real-case human_review records are
  present for all five cases.

Phase 7 close-out polish: after cases 01/02/03 were promoted to human_review,
`pnpm g4:review-pack -- --missing-human-review --dry-run` correctly selected
zero cases but exited with status 1. Treat an empty missing-human-review
selection as a successful no-op so the close-out check can verify that no real
generated cases are waiting for human G4 review. Keep empty
`--release-candidates` behavior unchanged because that selector is used to find
new review work, not to prove closure.

Validation result for the Phase 7 G4 close-out no-op slice:

- `pnpm g4:review-pack -- --missing-human-review --dry-run`: PASS and prints
  `no real generated cases without human_review G4 found`.
- `pnpm g4:review-pack -- --release-candidates --dry-run`: still exits 1 when
  no release candidates are available.
- Independent review found no critical findings. Adopted the major test finding
  by covering the empty release-candidate failure path directly.
- `pnpm vitest run server/g4-review-pack.test.ts`: PASS, 13 tests.
- `pnpm check`: PASS
- `pnpm test`: PASS, 27 test files and 312 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS; required real-case human_review records are
  present for all five cases.

Validation result for the Phase 7 prompt-check runner slice:

- Added `pnpm post-v1:prompt-check` as the no-write default runner for the
  remaining `authoring-v2-grounded-3` measurement.
- Default mode prints the case 03 video path, output directory, preflight
  command, side-effecting execution command, side-effect list, and promotion
  gate template without creating files or calling providers.
- `--execute` is rejected unless paired with `--accept-side-effects`; passing
  `--accept-side-effects` without `--execute` is also rejected.
- Execute mode is the explicit side-effecting path: it runs
  `pnpm pipeline:generate`, resolves the actual `project_*_steps.json`, then
  runs `pnpm eval:candidate -- --post-v1-promotion-gate --details`.
- Independent review initially found a critical issue in the printed promotion
  command: a quoted glob would not expand when copied. The plan now prints a
  `project_<project-id>_steps.json` template and explains that `<project-id>`
  must be replaced manually, while execute mode resolves the artifact
  automatically.
- Second review found no critical or major findings. Adopted minor fixes for
  consistent shell quoting and preserving `readdir` errors during artifact
  discovery.
- `pnpm vitest run server/post-v1-prompt-check.test.ts`: PASS, 4 tests.
- `pnpm post-v1:prompt-check -- --run-id test-run`: PASS and prints a no-write
  plan.
- `pnpm post-v1:prompt-check -- --execute --run-id test-run`: exits 1 as
  expected with `--execute requires --accept-side-effects`.
- `pnpm post-v1:prompt-check -- --accept-side-effects --run-id test-run`: exits
  1 as expected with `--accept-side-effects requires --execute`.
- `pnpm check`: PASS
- `pnpm test`: PASS, 28 test files and 316 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS; required real-case human_review records are
  present for all five cases.

Validation result for the Phase 7 prompt-check close-out verification slice:

- Re-ran the no-write `pnpm post-v1:prompt-check` plan for case 03 and confirmed
  it still prints the preflight command, side-effecting execution command,
  side-effect list, and promotion-gate template without creating artifacts.
- Re-ran `pnpm pipeline:generate -- --preflight` for the case 03 prompt-check
  path and confirmed it exits before outdir, DB, storage, provider, and
  `project_*_steps.json` writes.
- Re-ran `pnpm g4:review-pack -- --missing-human-review --dry-run` and confirmed
  no real generated cases remain without `human_review` G4.
- Hardened `server/cli/generatePipeline.test.ts` by giving the command-level
  `pnpm tsx` preflight subprocess test a 15 second timeout. The test still
  verifies the no-outdir-write boundary; the wider timeout prevents unrelated
  process startup contention from failing the full suite.
- `pnpm vitest run server/cli/generatePipeline.test.ts`: PASS, 3 tests.
- `pnpm check`: PASS
- `pnpm test`: PASS, 28 test files and 316 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS; required real-case human_review records are
  present for all five cases.

Validation result for the Phase 7 approved prompt measurement slice:

- Ran `pnpm post-v1:prompt-check -- --execute --accept-side-effects --run-id approved-20260621T220758`
  after explicit operator approval for DB/storage/provider/output side effects.
- The run created project `40` and exported
  `outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-approved-20260621T220758/project_40_steps.json`.
- Candidate prompt version: `authoring-v2-grounded-3`; required prompt version:
  `authoring-v2-grounded-3`.
- `pnpm eval:candidate -- --case real-app-workflow-03-generate-steps --steps outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-approved-20260621T220758/project_40_steps.json --post-v1-promotion-gate --details`:
  PASS.
- Candidate metrics: G2 `100.0%` versus fixed baseline `41.7%` and current
  tracked artifact `75.0%`; G2 no-citation `0.0%` with no current regression;
  unmatched cited labels `none`; G3 `0.0%` versus fixed baseline/current
  `25.0%`; fallback reasons `0`; `needs_review` steps `0`.
- The tracked generated artifact and `eval/baseline.json` were not updated.
  Promotion would require an explicit replacement decision and refreshed human
  review evidence because the existing case 03 `human_review` G4 record covers
  the current tracked artifact.
- `pnpm check`: PASS
- `pnpm test`: PASS, 28 test files and 316 tests passed, 1 skipped.
- `pnpm eval:audit`: PASS, 5/5 real recording cases.
- `pnpm eval:quality-gate`: PASS, G2=82.8%, G3=7.0%, fallback=0 for all real cases.
- `pnpm v1:release-audit`: PASS; required real-case human_review records are
  present for all five cases.
