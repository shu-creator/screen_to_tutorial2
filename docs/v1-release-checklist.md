# v1 Minimal Release Checklist

v1は「実録画からsteps.json v2を生成し、編集し、PPTX/動画を出力できる」ことを最小リリース範囲とする。

## Scope Decisions

- 既定LLMモデルは暫定で `gpt-5.4` を維持する。理由は再戦結果でG2引用精度が `gpt-5.5` より高かったため。
- `steps.json` 単一ソース化はv1では全面移行しない。v1は artifact-first で読み書きしつつ、既存DB `steps` テーブルとの同期互換を維持する。
- DB縮退、安定 `step_id` 基準の音声紐付け全面移行、旧単フレーム再生成の完全退役はpost-v1に回す。
- シーン検出系フォールバックと既存ヒューリスティックは、fallback混入が `pnpm eval:quality-gate` で検知される範囲でv1に残す。削除は実録画QA後のpost-v1負債整理とする。

## Required Before v1 Tag

- [ ] `pnpm setup:check` が通る
- [ ] `pnpm check` が通る
- [ ] `pnpm test` が通る
- [ ] `pnpm eval:audit` が通る
- [ ] `pnpm eval:quality-gate` が通る
- [ ] `pnpm v1:smoke -- --video <sample.mp4> --outdir ./outputs/v1-smoke --use-audio false --asr-provider none --ocr-provider none` が `pass=true` で完了する
- [ ] `pnpm v1:fresh-env-smoke -- --video <sample.mp4> --preflight-only` が `PASS` で完了する
- [ ] `pnpm v1:fresh-env-smoke -- --video <sample.mp4> --allow-install --install-mode offline` が `outputs/v1-fresh-env-smoke/v1_smoke_summary.json` を生成し、`environment.kind=fresh_checkout` を記録する
- [ ] `pnpm v1:release-audit` が `PASS` で完了する
- [ ] `pnpm pipeline:generate --video <sample.mp4> --outdir ./outputs --use-audio false --asr-provider none --ocr-provider llm` で `project_<id>_steps.json` が生成される
- [ ] `pnpm project:export -- --project-id <id> --audio-mode silent --outdir ./outputs/project-export` でPPTX/動画のsummaryが生成される
- [ ] `slide.content_check.status` が `pass` で、PPTX内のstep画像数とmedia画像数が期待step数を満たし、placeholder文字列が検出されない
- [ ] PPTXを開き、各ステップ画像がプレースホルダーではなく実画面になっていることを目視確認する
- [ ] 生成結果がfallback-heavyではないことを確認する
- [ ] `pnpm edit:smoke -- --project-id <id> --outdir ./outputs/edit-smoke` が `pass=true` / `restored_after_check=true` で完了する
- [ ] UIでタイトル、説明、ナレーション、`t_start` / `t_end`、ステップ音声モード、レビュー済み状態を編集し、artifact同期を確認する
- [ ] 評価ケース2本以上でPPTXと動画を生成し、表紙、完了スライド、スピーカーノート警告、無音/元音声、長尺クリップ、drawtext skip時の挙動を確認する
- [ ] G4 `human_review` を評価ケース2本以上の出荷判定対象ケースに記録する
- [ ] G4記録は `pnpm g4:record -- --case <case-id> --reviewer <name> --reviewed-at YYYY-MM-DD --confirm-human-review --dry-run` で内容確認してから書き込む
- [ ] README、`.env.example`、`docs/setup-local.md`、このチェックリストが実装と一致している

## Evidence To Attach

- `git rev-parse HEAD`
- `pnpm setup:check` 出力
- `pnpm check` / `pnpm test` / `pnpm eval:audit` / `pnpm eval:quality-gate` 出力
- `outputs/<chosen-v1-smoke-outdir>/v1_smoke_summary.json` のパスと、その時点のSHA-256
- `pnpm v1:fresh-env-smoke -- --preflight-only` 出力（前提確認のみ。fresh checkout証跡ではない）
- `outputs/v1-fresh-env-smoke/v1_smoke_summary.json` の `environment` と `fresh_env_commands`
- `pnpm v1:release-audit -- --json` の出力（FAIL/INCOMPLETE checkは `next_action` を含む）
- `outputs/project_<id>_steps.json` のパスとSHA-256
- `outputs/project-export/project_<id>_export_summary.json` のパスと、その時点のSHA-256
- `outputs/edit-smoke/project_<id>_edit_smoke_summary.json` のパスと、その時点のSHA-256
- 出力QAの `eval/results/export-qa/<case-id>/qa-summary.json`
- G4記録の対象ケース、review_type、総修正件数

## Latest Local Smoke Evidence

2026-06-20時点の既存ローカル環境では、合成評価動画で生成経路のスモークを通した。

- Input: `eval/dataset/synth-login-click-01/video.mp4`
- Command: `pnpm pipeline:generate --video eval/dataset/synth-login-click-01/video.mp4 --outdir outputs/v1-smoke --use-audio false --asr-provider none --ocr-provider none --max-frames 12`
- Output: `outputs/v1-smoke/project_28_steps.json`
- SHA-256: `2e752ae86dd7e89b55c06425de73a3a0b96bf292cff1910209a08053689969c9`
- Result: `version=2.0`, configured `LLM_MODEL=gpt-5.4`, `steps=3`, `needs_review=3`
- Export command: `pnpm project:export -- --project-id 28 --audio-mode silent --outdir outputs/project-export`
- Export summary: `outputs/project-export/project_28_export_summary.json`
- Export result: PPTX 154503 bytes, MP4 72262 bytes, `slide.content_check.status=pass`, `total_slide_count=6`, `slides_with_images=3`, `media_image_count=3`, `expected_step_image_count_source=steps_artifact`, `placeholder_text_hits=[]`, `still_image_fallback_count=0`
- Edit smoke command: `pnpm edit:smoke -- --project-id 28 --outdir outputs/edit-smoke`
- Edit smoke summary: `outputs/edit-smoke/project_28_edit_smoke_summary.json`
- Edit smoke result: `pass=true`, `restored_after_check=true`, `restore_error=null`
- V1 smoke command: `pnpm v1:smoke -- --video eval/dataset/synth-login-click-01/video.mp4 --outdir outputs/v1-smoke-default-check --use-audio false --asr-provider none --audio-mode silent --max-frames 12`
- V1 smoke summary: `outputs/v1-smoke-default-check/v1_smoke_summary.json`
- V1 smoke result: `pass=true`, project 32, default `ocr_provider=none`, steps SHA-256 `ffd61bc1e3fff231f764d26a6d59d86cb137c7b5120cea10fc88e5c744c6a945`, `step_count=3`, `needs_review_count=3`, `fallback_reason_count=0`
- V1 release audit command: `pnpm v1:release-audit -- --allow-incomplete`
- V1 release audit result: `INCOMPLETE`。`release.docs`、`model.default`、`eval.readiness`、`eval.quality_gate`、`smoke.current_environment`、`export.qa` はPASS。`g4.human_review` と `smoke.fresh_environment` は未達。

これは生成経路のスモークであり、v1出荷品質の証明ではない。OCRなしで実行したため全stepが `needs_review` になっており、PPTXの機械的な画像/placeholder検査はpassしたが、実画面として妥当かの目視確認は未記録である。最終v1判定には実録画/人間レビューG4/品質gate/PPTX目視確認が別途必要。

## Known Non-Release-Blocking Caveats

- `eval/results/` と評価動画はgitignore対象であり、新規環境では再生成または復元が必要
- 現在のG4記録は多くが `ai_estimate` であり、`human_review` の代替ではない
- `real-app-workflow-05-narrated-create-project` は画面は実録画だが音声はmacOS `say` の合成ナレーション
- drawtextまたはフォント指定が通らない環境では動画intro/outro title cardをskipし、warningに記録する
- `v1:fresh-env-smoke` は一時チェックアウト内で `pnpm install` を実行するため、実行前に依存インストールの副作用を明示確認する
