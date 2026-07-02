# Codex App Server Authoring Experiment

This worktree is for an API-free TutorialGen variant where Codex drives the
main step-authoring path.

## Goal

Support company environments where direct OpenAI Platform API usage is blocked
but Codex is available.

The first target is not to replace every AI-backed feature. It is to route step
authoring through Codex App Server while preserving the existing API-backed
`AUTHORING_PROVIDER=llm` path.

## Initial Mode

```env
AUTHORING_PROVIDER=codex_app_server
OCR_PROVIDER=engine
OCR_ENGINE_FALLBACK=none
OCR_PYTHON_BIN=.venv/bin/python3
ASR_PROVIDER=none
# ASR_PROVIDER=local_whisper is also API-free when the local whisper CLI is
# installed.
# TTS_PROVIDER=none is not supported yet. Leave TTS_PROVIDER=openai|gemini;
# pipeline:generate does not synthesize TTS in this experiment.
```

`LLM_PROVIDER` remains available for the existing API-backed mode, but
`AUTHORING_PROVIDER=codex_app_server` must not call `server/_core/llm.ts` for
step authoring. `OCR_PROVIDER=engine` is required for the first pass.
`OCR_PYTHON_BIN` selects the Python used to spawn `scripts/ocr_server.py`.
Use a project virtualenv when possible, for example `.venv/bin/python3`.
`OCR_ENGINE_FALLBACK=none` disables the legacy LLM-OCR fallback after local OCR
engine startup or recognition failure; the pipeline records empty OCR evidence
with a warning instead. The default remains `OCR_ENGINE_FALLBACK=llm` for
compatibility with the existing API-backed mode.
`ASR_PROVIDER=none` and `ASR_PROVIDER=local_whisper` are inside the API-free
scope; `ASR_PROVIDER=openai` remains outside it. Replacing OCR or TTS providers
is outside this slice.

`CODEX_MODEL` is optional. When set, TutorialGen launches app-server with
`-c model=<CODEX_MODEL>` and includes the value in the authoring cache key. When
unset, Codex uses the CLI default model and TutorialGen disables the Codex
authoring cache to avoid stale cache collisions.

## Architecture

```text
video
  -> evidence extraction
  -> codex_app_server authoring provider
  -> JSON extraction and schema validation
  -> existing authoring verification
  -> fallback completion
  -> steps.json
  -> eval/export
```

## Implementation Boundary

- Keep the existing OpenAI/Gemini/Claude path as `AUTHORING_PROVIDER=llm`.
- Add an authoring-provider interface under `server/authoring/providers/`.
- Move the current `invokeLLM` chunk authoring into the LLM provider.
- Add a Codex App Server provider that starts `codex app-server` over stdio,
  sends one authoring turn per chunk, and parses the final JSON response.
- Validate Codex output before accepting it. Invalid output must fall back to
  `fallback:chunk_authoring_failed`.

## Non-goals For The First Pass

- Do not use OpenAI ASR in API-free mode; use `ASR_PROVIDER=none` or local
  `ASR_PROVIDER=local_whisper`.
- Do not replace OpenAI/Gemini TTS.
- Do not use `OCR_PROVIDER=llm` in API-free mode.
- Do not support `TTS_PROVIDER=none` yet.
- Do not overwrite evaluation baselines or generated artifacts automatically.

## Preflight Contract

Use no-write preflight before the side-effecting run:

```bash
DATABASE_URL=mysql://root@127.0.0.1:3306/tutorialgen \
AUTHORING_PROVIDER=codex_app_server \
OCR_PROVIDER=engine \
OCR_ENGINE_FALLBACK=none \
OCR_PYTHON_BIN=.venv/bin/python3 \
ASR_PROVIDER=none \
pnpm pipeline:generate -- \
  --video outputs/codex-app-server-smoke/input/synth-login-click-01/video.mp4 \
  --outdir outputs/codex-app-server-smoke/run \
  --use-audio false \
  --asr-provider none \
  --ocr-provider engine \
  --max-frames 12 \
  --preflight
```

For narrated recordings, use local Whisper without Platform API calls:

```bash
AUTHORING_PROVIDER=codex_app_server \
OCR_PROVIDER=engine \
OCR_ENGINE_FALLBACK=none \
OCR_PYTHON_BIN=.venv/bin/python3 \
ASR_PROVIDER=local_whisper \
pnpm pipeline:generate -- \
  --video outputs/codex-app-server-smoke/input/narrated.mp4 \
  --outdir outputs/codex-app-server-smoke/run \
  --use-audio true \
  --asr-provider local_whisper \
  --ocr-provider engine \
  --preflight
```

Expected preflight checks:

- `authoring_provider`: confirms Codex authoring is active and legacy frame LLM
  authoring is disabled when evidence is missing.
- `evidence_required`: confirms the run must produce `evidence.json` before
  authoring.
- `asr_provider`: must be `none` or `local_whisper` for API-free mode;
  `openai` fails as outside scope.
- `asr_local_whisper_cli`: when `local_whisper` is selected, confirms the
  local `whisper` CLI is executable.
- `ocr_provider`: must be `engine`.
- `ocr_engine_fallback`: must be `none` for strict API-free operation. The
  default `llm` fallback is compatible with existing runs but can call LLM-OCR.
- `ocr_engine_dependencies`: confirms `OCR_PYTHON_BIN` can import Pillow and
  find PaddleOCR or Tesseract for local OCR. If this fails, create a project
  `.venv` and install OCR dependencies such as `paddlepaddle` and `paddleocr`,
  or provide a working Tesseract installation.
- `tts_provider`: records that TTS is not invoked by `pipeline:generate`.
- `codex_model`: records whether Codex authoring cache is enabled or disabled.
- `codex_app_server_cli`: confirms `codex app-server --listen stdio://`
  support.

## Validation Commands

Start narrow:

```bash
pnpm check
pnpm test server/authoring/author.test.ts \
  server/authoring/author.codex-provider.test.ts \
  server/authoring/providers/codexAppServer.test.ts \
  server/authoring/providers/json.test.ts \
  server/stepGenerator.codex-provider.test.ts \
  server/_core/env.test.ts \
  server/_core/llm.test.ts \
  server/stepsArtifact.test.ts \
  server/cli/generatePipeline.test.ts
DATABASE_URL=mysql://root@127.0.0.1:3306/tutorialgen \
AUTHORING_PROVIDER=codex_app_server \
OCR_PROVIDER=engine \
OCR_ENGINE_FALLBACK=none \
OCR_PYTHON_BIN=.venv/bin/python3 \
ASR_PROVIDER=none \
CODEX_APP_SERVER_TIMEOUT_MS=300000 \
pnpm pipeline:generate -- \
  --video outputs/codex-app-server-smoke/input/synth-login-click-01/video.mp4 \
  --outdir outputs/codex-app-server-smoke/run \
  --use-audio false \
  --asr-provider none \
  --ocr-provider engine \
  --max-frames 12
pnpm eval:candidate -- \
  --case synth-login-click-01 \
  --steps outputs/codex-app-server-smoke/run/project_<id>_steps.json \
  --details
```

Broaden only after the Codex path can produce schema-valid `steps.json`
reliably on one small case.

## Goal 0-5 Closeout

Date: 2026-06-29.

Smoke input:

- Generated synthetic video with
  `python3 eval/generate_dataset.py --case synth-login-click-01 --outdir outputs/codex-app-server-smoke/input`.
- Project: `47`.
- Output: `outputs/codex-app-server-smoke/run/project_47_steps.json`.

Results:

- Preflight: PASS.
- Pipeline smoke: completed and exported schema-valid `steps.json`.
- Authoring config: `authoring_provider=codex_app_server`,
  `ocr_provider=engine`, `asr_provider=none`,
  `prompt_version=authoring-v2-grounded-4`.
- Cache: `CODEX_MODEL` unset, Codex authoring cache disabled.
- Fallback: 3/3 steps used `fallback:unassigned_segment`.
- Eval candidate: FAIL for `synth-login-click-01` with G1-F1 40.0%, G2 0.0%,
  no-citation 100.0%, G3 33.3%, fallback reasons 3.
- Validation:
  - `pnpm check`: PASS.
  - Focused `pnpm test` set: PASS, 49 tests.
  - `git diff --check`: PASS.
- Independent review: Claude findings-first review completed. The major
  finding about possible false FAIL when `codex app-server --help` exits
  non-zero was accepted and fixed by reading stdout/stderr from non-zero help
  exits. The minor finding about preflight env injection was accepted and
  fixed. Remaining protocol-surface notes are recorded as residual risk.

Go/no-go:

- Go for the integration shape: app-server authoring can be invoked from the
  pipeline, returns through JSON extraction/schema validation, and still passes
  existing verification/fallback before artifact save.
- No-go for quality: this smoke is not acceptable as a TutorialGen authoring
  candidate because every step fell back. The next slice should improve
  evidence quality and prompt/protocol behavior before any promotion.

Observed risk:

- `OCR_PROVIDER=engine` started Tesseract, but the synthetic Japanese UI yielded
  weak/empty OCR evidence in the pipeline smoke. Sprint B made the engine
  fallback policy explicit: set `OCR_ENGINE_FALLBACK=none` for strict API-free
  operation, and use preflight to verify `OCR_PYTHON_BIN` points at a Python
  environment with local OCR dependencies. The remaining quality risk is local
  OCR accuracy, not hidden LLM-OCR fallback.
