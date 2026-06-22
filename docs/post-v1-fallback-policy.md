# Post-v1 Fallback Policy

This policy defines which fallback and heuristic paths can remain after `v1.0.0`, and which ones invalidate release or evaluation evidence.

## Source Of Truth

- `v1.0.0` release baseline: `e034c9cc3b9938ea91931d2f520f77e79080682c`
- Required release gate: `pnpm v1:release-audit`
- Required phase gates:
  - `pnpm check`
  - `pnpm test`
  - `pnpm eval:audit`
  - `pnpm eval:quality-gate`
  - `pnpm v1:release-audit`

## Step Authoring Reasons

`steps.json` records machine-readable reasons in `steps[].review_reasons`.

### Forbidden In Release / Eval Evidence

Any `review_reasons` entry beginning with `fallback:` is forbidden in release evidence and in the real-case artifacts used by `pnpm eval:quality-gate`.

Known forbidden step fallback reasons:

| Reason | Meaning | Current detector |
| --- | --- | --- |
| `fallback:chunk_authoring_failed` | LLM chunk authoring failed and the system generated fallback steps. | `pnpm eval:quality-gate`, `pnpm v1:smoke`, `pnpm v1:release-audit` |
| `fallback:unassigned_segment` | The authoring response left a non-waiting segment unassigned and fallback filled it. | `pnpm eval:quality-gate`, `pnpm v1:smoke`, `pnpm v1:release-audit` |
| `fallback:legacy_step_analysis_failed` | Legacy single-frame analysis failed and a fallback step was generated. | `pnpm eval:quality-gate`, `pnpm v1:smoke`, `pnpm v1:release-audit` |

Policy:

- These fallback reasons may remain as local recovery paths so the app can fail soft during interactive development.
- They must not appear in release smoke summaries or real-case quality-gate artifacts.
- A pipeline exit code of 0 is not enough. Inspect `fallback_reason_count`, `review_reasons`, and generated artifact contents.

### Allowed With Review Visibility

The following are not fallback reasons and do not automatically fail v1 release gates:

| Reason | Meaning | Required handling |
| --- | --- | --- |
| `verification:unverified_ui_label` | A cited UI label could not be verified against OCR evidence. | Keep `needs_review=true`; human review or later prompt/OCR improvement may address it. |
| `verification:low_confidence` | Deterministic confidence is below the review threshold. | Keep `needs_review=true`; do not hide the warning. |

These review reasons are allowed in deterministic OCR-disabled smoke runs when fallback count remains zero. They are quality work items, not silent success.

## Video / Export Fallbacks

Video fallback state is reported outside `review_reasons`.

| Signal | Policy | Current detector |
| --- | --- | --- |
| `video.still_image_fallback_count > 0` | Forbidden for release smoke. It means clip generation fell back to still images. | `pnpm v1:smoke`, `pnpm v1:release-audit` |
| Missing source video causing all-still output | Forbidden for release evidence; allowed only as interactive recovery with warning. | export summary / video warnings |
| TTS failure to silent audio | Allowed only if visible in warnings and reviewed for the target case; not a silent success. | video warnings / G4 review |
| `original` audio requested on a silent source and switched mode | Allowed only when warning is retained and output QA accepts the result. | video warnings / export QA |
| intro/outro title card skipped because `drawtext` or fonts are unavailable | Allowed when step clips still render and the warning is recorded. This is not a step fallback. | export QA summary / G4 notes |

## OCR / ASR Fallbacks

- `OCR_PROVIDER=engine` may fall back from PaddleOCR or Tesseract to LLM-OCR when local engines are unavailable.
- Release deterministic smoke currently uses `ocr_provider=none`; do not infer OCR quality from that smoke.
- ASR may be disabled with `ASR_PROVIDER=none` for deterministic smoke. Narrated-case quality remains a post-v1 improvement target.

## Heuristic Retirement Policy

Keep the following v1 heuristics until a focused post-v1 change proves they are unnecessary:

- `anonymizeOnScreenStepNumbers`
- `applyFinalStepCompletionFix`
- `buildDisplayTitleMap`
- slide-level layout trimming and punctuation helpers
- legacy scene-detection fallback
- legacy single-frame analysis fallback

Retire heuristics one at a time. For each removal:

1. Confirm references with `rg`.
2. Remove matching tests only when the behavior is intentionally retired.
3. Run the full phase validation set.
4. For slide/video-affecting changes, also run:
   `pnpm v1:smoke -- --video eval/dataset/synth-login-click-01/video.mp4 --outdir outputs/v1-smoke-default-check --use-audio false --asr-provider none --audio-mode silent --max-frames 12`
5. Inspect the smoke summary and export QA artifacts, not only command exit codes.

## Gate Coverage

Current coverage is sufficient for v1 preservation:

- `pnpm eval:quality-gate` fails when real-case generated artifacts contain `fallback:*` review reasons.
- `pnpm v1:smoke` fails when generated smoke steps contain fallback reasons or when video still-image fallback count is nonzero.
- `pnpm v1:release-audit` checks current smoke, fresh-env smoke, eval quality gate, export QA, and human G4 evidence.

No `eval:quality-gate` code change is required for Phase 4. Video/export fallbacks are intentionally checked by smoke/export/release gates rather than by the eval metric gate.
