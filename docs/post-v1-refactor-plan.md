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

Status: pending.

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

### Phase 2: Docs Cleanup

Status: pending.

Use `docs/v1-release-checklist.md` as the source of truth for v1 facts. Move historical material into a `Historical Notes` section when it should be retained.

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
