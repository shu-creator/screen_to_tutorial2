# Post-v1 Checklist

This checklist tracks release-follow-up work after the fixed `v1.0.0` baseline.
The v1 release proof remains `docs/v1-release-checklist.md`; this file is for
work that should improve the product after v1 without weakening release gates.

## Current Status

- Branch for Phase 7 follow-up: `codex/post-v1-refactor`
- Fixed baseline tag: `v1.0.0`
- Current quality baseline: G2 `69.4%`, G3 `7.0%`, fallback reasons `0`
- Required release audit remains `pnpm v1:release-audit`
- Human G4 records already exist for release-required cases 04 and 05.
- Cases 01, 02, and 03 still have `review_type: "ai_estimate"` records only.

## Human G4 For Cases 01/02/03

Do not overwrite `eval/g4/records/*.json` with `human_review` unless a human has
actually reviewed the steps/artifacts and counted corrections.

Review packets have been generated for:

- `outputs/g4-review-packets/real-app-workflow-01.md`
- `outputs/g4-review-packets/real-app-workflow-02-create-project.md`
- `outputs/g4-review-packets/real-app-workflow-03-generate-steps.md`

Regenerate the packets with:

```bash
pnpm g4:review-pack -- \
  --case real-app-workflow-01 \
  --case real-app-workflow-02-create-project \
  --case real-app-workflow-03-generate-steps \
  --overwrite
```

After actual human review, dry-run each record first:

```bash
pnpm g4:record -- \
  --case real-app-workflow-03-generate-steps \
  --reviewer "iwsh23" \
  --reviewed-at YYYY-MM-DD \
  --confirm-human-review \
  --dry-run \
  --title_edits 0 --description_edits 0 --narration_edits 0 --timing_edits 0 \
  --citation_edits 0 --step_structure_edits 0 --export_artifact_edits 0 --other_edits 0 \
  --notes "Human reviewed PPTX/video/steps and corrected to shippable state."
```

Only after inspecting the JSON, remove `--dry-run` and add `--overwrite`.

## Quality Prompt Follow-up

`server/authoring/author.ts` now uses `authoring-v2-grounded-2`. The prompt
tightens two low-G2 failure modes:

- do not merge distinct user intents such as tab open, generation start, and
  completion confirmation into one step;
- do not quote or include `cited_ui_labels` unless the label is present in the
  source segment OCR.

The persisted eval artifacts still record the older prompt version until cases
are regenerated. Measure prompt impact with low-G2 cases first:

```bash
pnpm pipeline:generate -- \
  --video eval/dataset/real-app-workflow-03-generate-steps/video.mp4 \
  --outdir outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps \
  --use-audio false \
  --asr-provider none
```

Then copy the candidate `steps.json` into a temporary eval result location and
run `pnpm eval` / `pnpm eval:quality-gate` before replacing any baseline
artifact. Do not update `eval/baseline.json` unless the new output is reviewed
and the improvement is intentional.

## Low-G2 Case Order

| Priority | Case | Current G2 | Current G3 | Focus |
| --- | --- | ---: | ---: | --- |
| 1 | `real-app-workflow-03-generate-steps` | `41.7%` | `25.0%` | missing generate/confirmation intervals, merged actions, weak citations |
| 2 | `real-app-workflow-04-export-video` | `55.6%` | `0.0%` | export/video controls and exact cited labels |
| 3 | `real-app-workflow-01` | `72.2%` | `10.0%` | split merged project/file-select actions |

## UI Polish Queue

- Keep edit/delete/reorder UI behavior aligned with the artifact-first route
  contract once the Phase 6 branch is merged.
- Add clearer review-state affordances for `needs_review`, timing/audio edits,
  and artifact sync status.
- Check mobile widths for project detail tabs, step cards, and export controls.
- Verify that button labels and icons fit without wrapping or overlap.

## Gate Before Closing Phase 7

Run and record:

```bash
pnpm check
pnpm test
pnpm eval:audit
pnpm eval:quality-gate
pnpm v1:release-audit
```

If any generated artifact or G4 record changes, also run the relevant focused
command:

```bash
pnpm g4:review-pack -- \
  --case real-app-workflow-01 \
  --case real-app-workflow-02-create-project \
  --case real-app-workflow-03-generate-steps \
  --overwrite
```
