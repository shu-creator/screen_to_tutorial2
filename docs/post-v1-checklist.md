# Post-v1 Checklist

This checklist tracks release-follow-up work after the fixed `v1.0.0` baseline.
The v1 release proof remains `docs/v1-release-checklist.md`; this file is for
work that should improve the product after v1 without weakening release gates.

## Current Status

- Branch for Phase 7 follow-up: `codex/post-v1-refactor`
- Fixed baseline tag: `v1.0.0`
- Fixed v1 quality baseline: G2 `69.4%`, G3 `7.0%`, fallback reasons `0`
- Current post-v1 quality gate on persisted local eval artifacts in this branch
  after case 03 promotion: G2 `87.8%`, G3 `2.0%`, fallback reasons `0`
- Required release audit remains `pnpm v1:release-audit`
- Human G4 records exist for all five real recording cases.
- Cases 01 and 02 were reviewed by `iwsh23` on `2026-06-21`; promoted case 03
  was reviewed by `iwsh23` on `2026-06-22`. All three have
  `total_manual_edits: 0` and no blocking issues.
- The case 03 `authoring-v2-grounded-3` candidate passed
  `--post-v1-promotion-gate`, was promoted into the persisted generated
  artifact, and has a refreshed `human_review` G4 record.

## Human G4 For Cases 01/02/03

Status: complete. Keep this workflow here for future replacement or audit runs.

Do not overwrite `eval/g4/records/*.json` with `human_review` unless a human has
actually reviewed the steps/artifacts and counted corrections.

Review packets have been generated for:

- `outputs/g4-review-packets/real-app-workflow-01.md`
- `outputs/g4-review-packets/real-app-workflow-02-create-project.md`
- `outputs/g4-review-packets/real-app-workflow-03-generate-steps.md`

Preview the selected cases, then regenerate the packets with:

```bash
pnpm g4:review-pack -- --missing-human-review --dry-run
pnpm g4:review-pack -- --missing-human-review --overwrite
```

This selector creates packets for real generated cases that do not yet have
`review_type: "human_review"`. After the `2026-06-21` human G4 update, it should
not surface cases 01, 02, or 03 unless their records are intentionally reverted.

After actual human review, dry-run each record first:

```bash
pnpm g4:record -- \
  --case <case-id> \
  --reviewer "<reviewer>" \
  --reviewed-at YYYY-MM-DD \
  --confirm-human-review \
  --dry-run \
  --title_edits 0 --description_edits 0 --narration_edits 0 --timing_edits 0 \
  --citation_edits 0 --step_structure_edits 0 --export_artifact_edits 0 --other_edits 0 \
  --notes "Human reviewed PPTX/video/steps and corrected to shippable state."
```

Only after inspecting the JSON, remove `--dry-run` and add `--overwrite`.

## Quality Prompt Follow-up

`server/authoring/author.ts` now uses `authoring-v2-grounded-3`. The prompt
tightens three low-G2 failure modes:

- do not merge distinct user intents such as tab open, generation start, and
  completion confirmation into one step;
- do not quote or include `cited_ui_labels` unless the label is present in the
  source segment OCR.
- do not include state/result-only text such as `プレビュー`, `完了`,
  `ステップがありません`, or `ステップの生成を開始しました` in
  `cited_ui_labels` unless that text is the explicit confirmation target.

Case 03 has been promoted to current-prompt output. Use this workflow to re-run
future prompt impact checks before replacing any persisted eval artifact:

```bash
pnpm post-v1:prompt-check -- --run-id "$(date +%Y%m%dT%H%M)"
```

The default mode prints a no-write plan, including the preflight command, the
side-effecting execution command, and the promotion-gate command. To run the
measurement from that single runner, use `--execute --accept-side-effects` only
after accepting the DB/storage/provider effects described below. The printed
promotion-gate command uses `project_<project-id>_steps.json` as a template;
replace `<project-id>` with the generated project id when running the command
manually, or use the runner's `--execute` mode to resolve it automatically.

Manual equivalent:

```bash
RUN_ID=$(date +%Y%m%dT%H%M)
pnpm pipeline:generate -- \
  --video eval/dataset/real-app-workflow-03-generate-steps/video.mp4 \
  --outdir "outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-${RUN_ID}" \
  --use-audio false \
  --asr-provider none \
  --preflight
```

`--preflight` is the no-write planning check. It exits before creating DB
records, creating the output directory, storing the source video, processing
evidence, or writing `project_*_steps.json`. Existing `--dry-run` is not a
no-write mode: it still creates the output directory, creates the CLI
user/project, and stores the source video before skipping processing.

After inspecting the preflight output, run the generation command without
`--preflight` only after explicitly accepting the local side effects. The real
generation command creates the output directory, creates or updates CLI
user/project state in the configured database, stores the source video, invokes
the pipeline/authoring providers configured by the environment, and writes an
exported `project_*_steps.json`.

```bash
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

The output prints the candidate `prompt version` and, when comparing against the
persisted generated artifact, `current artifact prompt version`. Confirm these
before promoting a candidate. The earlier `project_39_steps.json` candidate was
from `authoring-v2-grounded-2` and is retained below as a stale-prompt example;
the current `project_40_steps.json` candidate is from `authoring-v2-grounded-3`.
The `--post-v1-promotion-gate` check rejects candidates whose prompt version
does not match the active authoring prompt.

For diagnostic detail, the general eval runner can also score an arbitrary
artifact:

```bash
pnpm eval -- \
  --case real-app-workflow-03-generate-steps \
  --steps "$STEPS_PATH"
```

Do not update `eval/results/generated/*` or `eval/baseline.json` unless the new
output is reviewed and the improvement is intentional.

Earlier measured candidate:

- `real-app-workflow-03-generate-steps` regenerated locally at
  `outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-20260621T0902/project_39_steps.json`.
- Prompt path: `authoring-v2-grounded-2`.
- Follow-up prompt path: `authoring-v2-grounded-3` adds the state/result-only
  label exclusion above. The measured local candidate predates this prompt and
  has not been regenerated.
- Fixed-baseline gate: `pnpm eval:candidate -- --case real-app-workflow-03-generate-steps --steps outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-20260621T0902/project_39_steps.json --require-g2-improvement` PASS.
- Current-artifact diagnostic: `pnpm eval:candidate -- --case real-app-workflow-03-generate-steps --steps outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-20260621T0902/project_39_steps.json --current-generated --json` reports current G2 delta `-3.6%` and current G3 delta `-25.0%`.
- Strict promotion check with `--post-v1-promotion-gate` fails as expected with
  `prompt_version_mismatch` and current-artifact G2 regression; this candidate
  predates the active `authoring-v2-grounded-3` prompt and should not be
  promoted. Add `--details` to list candidate cited labels that do not match
  the case's allowed UI label set.
- Result vs fixed baseline: G2 `71.4%` (baseline `41.7%`, delta `+29.8%`),
  G3 `0.0%` (baseline `25.0%`, delta `-25.0%`), fallback reasons `0`,
  `needs_review` steps `0`.
- The persisted generated artifact and `eval/baseline.json` were not updated.
- Note: `--require-g2-improvement` compares against `eval/baseline.json`, which
  still records the fixed v1 case 03 G2 of `41.7%`. Under the current post-v1
  label normalizer at the time of this measurement, the persisted case 03 artifact
  scored G2 `75.0%` (since promoted to `100.0%`), so this PASS did not prove
  improvement over that persisted artifact. Use
  `--post-v1-promotion-gate` for the combined fixed-baseline G2 improvement,
  current generated artifact no-G2-regression, no-citation-regression, and
  G3-improvement promotion check.

Promotion decision:

- Do not promote the `project_39_steps.json` candidate. Under the post-v1 label
  normalizer at the time of this measurement, the persisted case 03 artifact
  scored G2 `75.0%` and G3 `25.0%` (since promoted to `100.0%` / `0.0%`);
  the local candidate scored G2 `71.4%` and G3 `0.0%`.
- The candidate improves timing/overlap but lowered G2 versus the then-current
  persisted artifact, so replacing `eval/results/generated/*` or
  `eval/baseline.json` still needs explicit product/human review.

Current-prompt measured candidate:

- `real-app-workflow-03-generate-steps` regenerated locally after explicit
  side-effect approval at
  `outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-approved-20260621T220758/project_40_steps.json`.
- Prompt path: `authoring-v2-grounded-3`.
- Promotion gate:
  `pnpm eval:candidate -- --case real-app-workflow-03-generate-steps --steps outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-approved-20260621T220758/project_40_steps.json --post-v1-promotion-gate --details`
  PASS.
- Result vs fixed baseline: G2 `100.0%` (baseline `41.7%`, delta `+58.3%`),
  G3 `0.0%` (baseline `25.0%`, delta `-25.0%`), fallback reasons `0`,
  `needs_review` steps `0`.
- Result vs then-current persisted artifact before promotion: G2 `100.0%`
  (previous `75.0%`, delta `+25.0%`), G2 no-citation `0.0%` (no regression),
  G3 `0.0%` (previous `25.0%`, delta `-25.0%`), unmatched cited labels `none`.

Current-prompt promotion decision:

- The persisted generated artifact was updated from `project_40_steps.json`
  after explicit human approval on `2026-06-22`.
- `eval/baseline.json` remains fixed to the v1 baseline.
- The replacement case 03 `human_review` G4 record points to the promoted
  persisted artifact SHA
  `88208bb96925978ba14f63d1749def4f01a23073650f78d63b2a1561edc40d8a`.
- Project 40 export artifacts remain local-only review evidence; they are not
  tracked release artifacts.

Promotion record for `project_40_steps.json`:

1. Inspect machine QA results and locate generated artifacts:

   - summary:
     `outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-approved-20260621T220758/export/project_40_export_summary.json`
   - PPTX:
     `data/storage/projects/40/slides/1782052816971.pptx`
   - MP4:
     `data/storage/projects/40/videos/pYfEMLFuo0B_C89M0iUVm.mp4`
   - human-review worksheet:
     `outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-approved-20260621T220758/human-review-packet.md`
     (`sha256:bc16f24599b4c952a04a3f6f75a7cf9d468b01ee90874bc43eee35d4b9798aa5`)

   These paths are local-only and gitignored. If local `outputs/` or `data/`
   is cleared while DB project `40` still exists, regenerate the export files
   on the same local checkout with:

   ```bash
   pnpm project:export -- \
     --project-id 40 \
     --audio-mode silent \
     --outdir outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-approved-20260621T220758/export
   ```

   The export command does not regenerate `human-review-packet.md`. If the
   worksheet is lost before review, regenerate it from the candidate steps and
   export summary with:

   ```bash
   pnpm post-v1:prompt-check -- \
     --review-packet \
     --case real-app-workflow-03-generate-steps \
     --steps outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-approved-20260621T220758/project_40_steps.json \
     --export-summary outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-approved-20260621T220758/export/project_40_export_summary.json \
     --out outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-approved-20260621T220758/human-review-packet.md \
     --overwrite
   ```

   If DB project `40` is cleared before review, export-only regeneration is not
   possible. Re-run the prompt check with
   `pnpm post-v1:prompt-check -- --execute --accept-side-effects --run-id <new-run-id>`
   to create a new local project, then export that new project ID.

   Machine checks: PPTX content check `pass`, total slides `7`, media images
   `4`, slides with images `4`, speaker-note review warnings `0`, placeholder
   hits `0`; MP4 duration `11.8s`, video stream present, silent-mode audio
   stream present, still-image fallback count `0`. The only recorded video
   warning is that no usable font was available, so the intro card was skipped.

2. Human review was accepted on `2026-06-22` with reviewer `iwsh23`, all edit
   counts `0`, and no blocking issues. The candidate was copied into the
   persisted generated artifact path so the replacement G4 record points to the
   local artifact that the audit hashes in this checkout:

   ```bash
   cp \
     outputs/post-v1-prompt-check/real-app-workflow-03-generate-steps-run-approved-20260621T220758/project_40_steps.json \
     eval/results/generated/real-app-workflow-03-generate-steps/steps.json
   ```

3. A replacement G4 review was recorded against the persisted generated artifact.
   The dry-run was inspected first:

   ```bash
   pnpm g4:record -- \
     --case real-app-workflow-03-generate-steps \
     --reviewer "iwsh23" \
     --reviewed-at 2026-06-22 \
     --confirm-human-review \
     --dry-run \
     --title_edits 0 --description_edits 0 --narration_edits 0 --timing_edits 0 \
     --citation_edits 0 --step_structure_edits 0 --export_artifact_edits 0 --other_edits 0 \
     --notes "Human reviewed promoted authoring-v2-grounded-3 candidate and project 40 export artifacts; no fixes needed."
   ```

4. After inspecting the dry-run JSON, the same command was rerun without
   `--dry-run` and with `--overwrite`. The full phase gate set was required to
   pass before committing the promotion, and all gates passed:

   ```bash
   pnpm check
   pnpm test
   pnpm eval:audit
   pnpm eval:quality-gate
   pnpm v1:release-audit
   ```

## Remaining Low-G2/G3 Case Order

| Priority | Case | Tracked G2 (post-v1 norm) | Tracked G3 (post-v1 norm) | v1 baseline G2 | Focus |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | `real-app-workflow-04-export-video` | `77.8%` | `0.0%` | `55.6%` | export/video controls and exact cited labels |
| 2 | `real-app-workflow-01` | `83.3%` | `10.0%` | `72.2%` | split merged project/file-select actions |
| resolved | `real-app-workflow-03-generate-steps` | `100.0%` | `0.0%` | `41.7%` | promoted on `2026-06-22`; future candidates must not regress G2 |

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
pnpm g4:review-pack -- --missing-human-review --dry-run
pnpm g4:review-pack -- --missing-human-review --overwrite
```

Once all pending real cases have human G4 records, this selector is expected to
find no cases and exit successfully with:

```text
no real generated cases without human_review G4 found
```
