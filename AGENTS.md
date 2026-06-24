# Repository Operating Guide

This file is the local entry point for Codex/Claude/other coding agents working
in this repository. Keep it short and point to the project docs as the source of
truth.

## Project State

- Product: TutorialGen, a local tool that turns screen recordings into editable
  tutorial steps, PPTX, and MP4 output.
- Fixed release baseline: `v1.0.0` points to
  `e034c9cc3b9938ea91931d2f520f77e79080682c`.
- Do not push, tag, or rewrite release history from an agent session.
- Treat `docs/v1-release-checklist.md` as the v1 proof record.
- Treat `docs/post-v1-checklist.md` and `docs/post-v1-refactor-plan.md` as the
  current post-v1 work map.

## Source Of Truth

- Requirements: `docs/requirements.md`
- Roadmap: `docs/roadmap.md`
- Local setup: `docs/setup-local.md`
- Evaluation harness: `eval/README.md`
- G4 human review format: `eval/g4/README.md`
- v1 release checklist: `docs/v1-release-checklist.md`
- post-v1 checklist: `docs/post-v1-checklist.md`
- fallback policy: `docs/post-v1-fallback-policy.md`
- artifact and DB responsibility: `docs/post-v1-artifact-db-responsibility.md`
- steps source migration/completion: `docs/post-v1-steps-source-migration.md`,
  `docs/post-v1-steps-source-completion-audit.md`

## Setup And Run

Use Node.js 22+, pnpm, MySQL-compatible DB, ffmpeg, and ffprobe.

```bash
pnpm install
cp .env.example .env
pnpm setup:check
pnpm db:push
pnpm dev
```

Full generation needs configured provider credentials. `pipeline:generate
--preflight` is the no-write planning mode. Existing `--dry-run` is not
no-write; it may still create local output/project/storage state before
skipping processing.

## Validation

For normal code changes, run the smallest relevant subset first, then broaden
when behavior touches shared generation, evaluation, export, edit sync, or
release gates.

```bash
pnpm check
pnpm test
pnpm eval:audit
pnpm eval:quality-gate
pnpm v1:release-audit -- --json
```

Use `pnpm v1:smoke` for local end-to-end smoke, and
`pnpm v1:fresh-env-smoke -- --preflight-only` before any fresh checkout smoke
that would install dependencies. Do not run dependency-installing fresh-env
checks without explicit user approval.

## Evaluation Rules

- `eval/results/`, `outputs/`, local storage, and video bodies are generally
  gitignored. Do not treat chat text as success evidence; inspect persisted
  summaries, `steps.json`, `qa-summary.json`, and gate output.
- `pnpm eval:quality-gate` reads persisted generated artifacts under
  `eval/results/generated/<case-id>/steps.json`.
- `pnpm eval:candidate` is the safe way to score a candidate `steps.json`
  without replacing the persisted artifact.
- For post-v1 promotion, prefer `pnpm eval:candidate -- --post-v1-promotion-gate`
  and confirm prompt version, G2, no-citation rate, G3, and fallback reasons.
- Do not update `eval/baseline.json` or `eval/results/generated/*` unless the
  replacement is intentional and reviewed.

## G4 And Human Review

- Keep `human_review` and `ai_estimate` separate.
- Never invent or auto-write a `human_review` record. Only record
  `human_review` after a human has actually reviewed the steps/artifacts and
  counted edits.
- Use `pnpm g4:review-pack` to generate review worksheets. This does not write a
  G4 record.
- Use `pnpm g4:record -- --dry-run ...` first, inspect the JSON, then rerun
  without `--dry-run` and with `--overwrite` only when replacing an accepted
  record.
- If a promoted candidate replaces `eval/results/generated/<case-id>/steps.json`,
  the previous G4 `source_artifact_sha256` becomes stale. Re-record the
  matching human G4 before expecting `pnpm v1:release-audit` to pass.

## Post-v1 Work Boundaries

- Preserve the v1 baseline and release evidence.
- Keep initial post-v1 work focused on generation quality unless the user
  explicitly changes scope.
- Avoid broad single-source rewrites, old fallback retirement, or large
  refactors unless a specific post-v1 phase asks for them.
- Prefer small prompt, verification, candidate-evaluation, or review-packet
  changes that can be validated against one target case and then against the
  full gate set.
- If touching multiple files, release gates, eval logic, artifact schema,
  G4/human-review behavior, settings, or MCP configuration, run an independent
  reviewer-only pass before final handoff.

## Safety Boundaries

- Do not run `git push`, create/move tags, hard reset, broad deletes, or
  destructive cleanup.
- Ask before dependency installation, external service use, production access,
  MCP configuration changes, or large video imports.
- Do not expose secrets, raw private notes, local credentials, database contents,
  or large generated artifacts in responses.
- Do not commit gitignored generated outputs, videos, local storage, cache, or
  review packets unless the user explicitly asks and the file is intended to be
  tracked.

## Palmier Pro

Palmier Pro is a possible post-v1 auxiliary lane, not a replacement for the
deterministic pipeline or eval gates.

- Verify current official README/docs/FAQ before implementation.
- Do not add Codex/Claude MCP settings without explaining the impact first.
- Do not use paid AI generation, upscale, chat, or large media batches in an
  initial experiment.
- If available locally, test only a small MP4 and classify Palmier as support
  for G4 review, `t_start`/`t_end` visual adjustment, and MP4 QA. Final judgment
  still comes from `pnpm eval*`, `qa-summary.json`, `steps.json`, and G4 records.
