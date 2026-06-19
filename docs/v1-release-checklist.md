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
- [ ] `pnpm pipeline:generate --video <sample.mp4> --outdir ./outputs --use-audio false --asr-provider none --ocr-provider llm` で `project_<id>_steps.json` が生成される
- [ ] 生成結果がfallback-heavyではないことを確認する
- [ ] UIでタイトル、説明、ナレーション、`t_start` / `t_end`、ステップ音声モード、レビュー済み状態を編集し、artifact同期を確認する
- [ ] 評価ケース2本以上でPPTXと動画を生成し、表紙、完了スライド、スピーカーノート警告、無音/元音声、長尺クリップ、drawtext skip時の挙動を確認する
- [ ] G4 `human_review` を少なくとも出荷判定対象ケースに記録する
- [ ] README、`.env.example`、`docs/setup-local.md`、このチェックリストが実装と一致している

## Evidence To Attach

- `git rev-parse HEAD`
- `pnpm setup:check` 出力
- `pnpm check` / `pnpm test` / `pnpm eval:audit` / `pnpm eval:quality-gate` 出力
- `outputs/project_<id>_steps.json` のパスとSHA-256
- 出力QAの `eval/results/export-qa/<case-id>/qa-summary.json`
- G4記録の対象ケース、review_type、総修正件数

## Known Non-Release-Blocking Caveats

- `eval/results/` と評価動画はgitignore対象であり、新規環境では再生成または復元が必要
- 現在のG4記録は多くが `ai_estimate` であり、`human_review` の代替ではない
- `real-app-workflow-05-narrated-create-project` は画面は実録画だが音声はmacOS `say` の合成ナレーション
- drawtextまたはフォント指定が通らない環境では動画intro/outro title cardをskipし、warningに記録する
