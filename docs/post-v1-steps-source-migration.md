# Post-v1 Steps Source Migration

## Status

Phase 6 branch: `codex/post-v1-steps-source-v2`

This branch starts from the completed `codex/post-v1-refactor` Phase 7 close-out
state. This kickoff document is the first Phase 6 artifact on the branch; there
is no implementation code yet. The older branch `codex/post-v1-steps-source`
already exists, but it is based before the Phase 7 prompt, G4, review-packet,
and quality-gate follow-up commits. Treat it as a patch source only, not as the
branch to continue.

Old branch audit:

- Old branch head: `bcc726859bab3b9b7a9423b20497daf4f76bd168`
- Old branch commit: `feat: make step editing artifact-first`
- Compared with `codex/post-v1-refactor`, the old branch would delete or roll
  back Phase 7 files such as `docs/post-v1-checklist.md`,
  `scripts/eval-candidate.ts`, `scripts/post-v1-prompt-check.ts`, and related
  tests.
- Do not merge the old branch wholesale. Cherry-pick or port individual ideas
  only after reconciling them with current Phase 7 artifacts and gates.

## Migration Goal

Move step editing toward a single artifact-derived source of truth while keeping
existing projects loadable and preserving v1 release-audit behavior.

The target source contract is:

- `steps.json` owns ordered step content, timing, review metadata, audio mode,
  evidence references, and export/render metadata.
- DB `steps` remains a compatibility index only while legacy IDs are needed.
- `legacy_step_db_id` remains during the first migration slice so existing UI
  mutations can address a stable step.
- UI list/read/edit paths should consume one artifact-derived adapter instead
  of independently merging DB rows and artifact metadata in the page.

## Initial Decisions

- Do not remove DB step rows in the first implementation slice.
- Do not remove `legacy_step_db_id` in the first implementation slice.
- Make artifact loading and patching a server-side adapter boundary before
  changing UI behavior.
- Resolve the current non-atomic `step.update` dual-write by either collapsing
  edits to one writer or adding explicit consistency recovery before widening
  artifact-first writes.
- Keep DB fallback explicit for projects without `steps.json`.
- Keep export, slide, video, eval, and release-audit behavior artifact-first and
  backward compatible.
- Preserve `pnpm edit:smoke` as the compatibility smoke, then expand it or add
  route-level tests for artifact-first edit behavior.

## Port Candidates From Old Branch

The old `bcc7268` commit may still contain useful implementation pieces:

- `server/stepSource.ts`
- `server/stepSource.test.ts`
- `server/stepSource.router.test.ts`
- focused changes in `server/stepsArtifact.ts`
- focused router changes in `server/routers.ts`

Porting rule:

1. Review each file against current `codex/post-v1-refactor`.
2. Port the adapter and tests first.
3. Port router behavior only after adapter tests pass.
4. Avoid copying doc or package changes that predate Phase 7.

## Implementation Order

1. Add or port a `stepSource` adapter that returns UI-ready steps from
   `steps.json` plus a DB compatibility bridge.
2. Cover adapter behavior for artifact-present, artifact-missing, partial bridge,
   edit, delete, reorder, and review-state clearing cases.
3. Move `step.listByProject` and `step.artifactInfo` toward the adapter without
   changing the client contract in the same commit.
4. Move `step.update` to patch artifact data as the primary write and mirror DB
   text fields only for compatibility. This slice must also define the
   consistency strategy for DB write failure after artifact save.
5. Add route-level tests for update/delete/reorder/regenerate behavior.
6. Update `pnpm edit:smoke` expectations only after route tests define the new
   source contract.
7. Re-run export, eval, and release gates before removing any compatibility
   fallback.
8. When Phase 6 changes prompt or generation behavior, use the no-write
   `pnpm post-v1:prompt-check` plan and
   `pnpm pipeline:generate -- --preflight` path before accepting DB/storage
   side effects.

## Required Verification

Run at every Phase 6 slice boundary:

```bash
pnpm check
pnpm test
pnpm eval:audit
pnpm eval:quality-gate
pnpm v1:release-audit
```

Additional Phase 6 checks:

```bash
# Requires outputs/v1-smoke-default-check/v1_smoke_summary.json.
# If it is absent, regenerate it first:
#   pnpm v1:smoke -- --video eval/dataset/synth-login-click-01/video.mp4 \
#     --outdir outputs/v1-smoke-default-check --use-audio false \
#     --asr-provider none --audio-mode silent --max-frames 12
PROJECT_ID=$(node -p "require('./outputs/v1-smoke-default-check/v1_smoke_summary.json').project_id")
pnpm edit:smoke -- --project-id "$PROJECT_ID" --outdir outputs/edit-smoke
pnpm g4:review-pack -- --missing-human-review --dry-run
```

Expected close-out invariants:

- Existing DB-backed projects still load.
- Artifact-backed projects render the same step order in UI, slides, video, and
  export.
- Edit, delete, reorder, regenerate, audio generation, slide export, video
  export, and edit smoke all use the same documented source contract.
- `pnpm v1:release-audit` remains PASS.
