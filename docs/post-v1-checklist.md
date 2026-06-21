# Post-v1 Checklist

This checklist tracks release-follow-up work after the fixed `v1.0.0` baseline.
The v1 release proof remains `docs/v1-release-checklist.md`; this file is for
work that should improve the product after v1 without weakening release gates.

## Current Status

- Branch for Phase 7 follow-up: `codex/post-v1-refactor`
- Fixed baseline tag: `v1.0.0`
- Fixed v1 quality baseline: G2 `69.4%`, G3 `7.0%`, fallback reasons `0`
- Current post-v1 quality gate on tracked artifacts in this branch: G2
  `82.8%`, G3 `7.0%`, fallback reasons `0`
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
pnpm g4:review-pack -- --missing-human-review --overwrite
```

This selector creates packets for real generated cases that do not yet have
`review_type: "human_review"`. On this branch it should surface cases 01, 02,
and 03.

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

The persisted eval artifacts have not been regenerated from the current prompt.
Measure prompt impact with low-G2 cases first:

```bash
RUN_ID=$(date +%Y%m%dT%H%M)
pnpm pipeline:generate -- \
  --video eval/dataset/real-app-workflow-03-generate-steps/video.mp4 \
  --outdir "outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-${RUN_ID}" \
  --use-audio false \
  --asr-provider none

STEPS_PATH=$(echo "outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-${RUN_ID}"/project_*_steps.json)
[[ -f "$STEPS_PATH" ]] || { echo "Error: steps file not found: $STEPS_PATH"; exit 1; }
```

`project_*_steps.json` includes the database project ID assigned during that
run, for example `project_39_steps.json`.

Then evaluate the candidate without copying it over the tracked generated
artifact:

```bash
STEPS_PATH=${STEPS_PATH:?run the generation block first}
pnpm eval:candidate -- \
  --case real-app-workflow-03-generate-steps \
  --steps "$STEPS_PATH" \
  --post-v1-promotion-gate \
  --details
```

For diagnostic detail, the general eval runner can also score an arbitrary
artifact:

```bash
pnpm eval -- \
  --case real-app-workflow-03-generate-steps \
  --steps "$STEPS_PATH"
```

Do not update `eval/results/generated/*` or `eval/baseline.json` unless the new
output is reviewed and the improvement is intentional.

Measured candidate:

- `real-app-workflow-03-generate-steps` regenerated locally at
  `outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-20260621T0902/project_39_steps.json`.
- Prompt path: `authoring-v2-grounded-2`.
- Fixed-baseline gate: `pnpm eval:candidate -- --case real-app-workflow-03-generate-steps --steps outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-20260621T0902/project_39_steps.json --require-g2-improvement` PASS.
- Current-artifact diagnostic: `pnpm eval:candidate -- --case real-app-workflow-03-generate-steps --steps outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-20260621T0902/project_39_steps.json --current-generated --json` reports current G2 delta `-3.6%` and current G3 delta `-25.0%`.
- Strict promotion check with `--post-v1-promotion-gate` fails as expected with
  `current_g2_regression`; add `--details` to list candidate cited labels that
  do not match the case's allowed UI label set.
- Result vs fixed baseline: G2 `71.4%` (baseline `41.7%`, delta `+29.8%`),
  G3 `0.0%` (baseline `25.0%`, delta `-25.0%`), fallback reasons `0`,
  `needs_review` steps `0`.
- The tracked generated artifact and `eval/baseline.json` were not updated.
- Note: `--require-g2-improvement` compares against `eval/baseline.json`, which
  still records the fixed v1 case 03 G2 of `41.7%`. Under the current post-v1
  label normalizer, the tracked case 03 artifact scores G2 `75.0%`, so this
  PASS does not prove improvement over the current tracked artifact. Use
  `--post-v1-promotion-gate` for the combined fixed-baseline G2 improvement,
  current generated artifact no-G2-regression, no-citation-regression, and
  G3-improvement promotion check.

Promotion decision:

- Do not promote this candidate yet. Under the current post-v1 label
  normalizer, the tracked case 03 artifact scores G2 `75.0%` and G3 `25.0%`;
  the local candidate scores G2 `71.4%` and G3 `0.0%`.
- The candidate improves timing/overlap but lowers G2 versus the current
  tracked artifact, so replacing `eval/results/generated/*` or
  `eval/baseline.json` still needs explicit product/human review.

## Low-G2/G3 Case Order

| Priority | Case | Tracked G2 (post-v1 norm) | Tracked G3 (post-v1 norm) | v1 baseline G2 | Focus |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | `real-app-workflow-03-generate-steps` | `75.0%` | `25.0%` | `41.7%` | reduce overlap/G3 without giving back G2 gains |
| 2 | `real-app-workflow-04-export-video` | `77.8%` | `0.0%` | `55.6%` | export/video controls and exact cited labels |
| 3 | `real-app-workflow-01` | `83.3%` | `10.0%` | `72.2%` | split merged project/file-select actions |

## UI Polish Queue

Open:

- Keep edit/delete/reorder UI behavior aligned with the artifact-first route
  contract once the Phase 6 branch is merged.
- Artifact sync status remains queued because the Phase 6 artifact-first route
  is still separate from this branch.

Done:

- Added clearer review-state affordances on project step cards: timing range,
  confidence, audio mode, narration iconography, and edit/delete icons.
- Kept step edit forms open after blur-save so reviewers can update title,
  operation, description, narration, timing, audio mode, and review state in one
  pass before closing the card.
- Suppressed no-op blur saves and reset cleared timing fields back to the stored
  value so the persistent edit form does not drift from artifact state.
- Checked project detail tabs, step cards, and export controls at desktop,
  390px, and 320px widths; tabs now use a three-column layout so labels stay
  visible.
- Verified that the updated button labels and icons fit without overlap.

## Gate Before Closing Phase 7

Run and record:

```bash
pnpm check
pnpm test
pnpm eval:audit
pnpm eval:quality-gate
pnpm v1:release-audit
```

If generated artifacts changed and `pnpm eval:audit` still reports real cases
without `human_review`, regenerate the relevant review packets:

```bash
pnpm g4:review-pack -- --missing-human-review --overwrite
```

Once all pending real cases have human G4 records, this selector is expected to
find no cases and should be skipped.
