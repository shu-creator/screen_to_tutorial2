# 評価ハーネス（Phase 0）

生成品質を G1〜G4（[docs/plans/phase-0-eval-harness.md](../docs/plans/phase-0-eval-harness.md)）で測定する。

## クイックスタート

```bash
# 1. 合成データセットを生成（動画はコミット対象外。いつでも決定的に再生成できる）
pnpm eval:dataset

# 2. パイプラインで生成物を作る（DB + LLM APIキーが必要）
#    出力を eval/results/generated/<case-id>/steps.json に配置

# 3. 評価を実行
pnpm eval
pnpm eval -- --case synth-login-click-01
pnpm eval -- --steps path/to/steps.json --case synth-login-click-01

# 4. ベースラインの確定（最初の実測時に1回）
pnpm eval -- --save-baseline

# 5. Sprint 1の実録画/G4 readinessを監査
pnpm eval:audit
pnpm eval:audit -- --allow-incomplete

# 6. Sprint 2の品質gateを確認
pnpm eval:quality-gate

# 7. Sprint 4のPPTX/動画QA用に評価ケースから成果物を生成
pnpm eval:export-case -- --case real-app-workflow-04-export-video --case real-app-workflow-05-narrated-create-project
```

## データセット構成

```
eval/dataset/<case-id>/
  ground_truth.json   # 正解（コミット対象）
  meta.json           # SHA-256・再生成コマンド・特性（コミット対象）
  video.mp4           # 動画実体（gitignore。meta.json から再生成）
```

### 合成ケース（eval/generate_dataset.py で生成）

| case-id | 検証対象 |
|---------|---------|
| synth-login-click-01 | 基本のクリック遷移 + スクロール（non_step） |
| synth-form-typing-01 | 1文字ずつのタイピング（coalescing） |
| synth-modal-fade-01 | モーダルのフェードイン/アウト（遷移途中フレーム） |

合成ケースはセグメンテーション・OCR・ハーネス配管の検証用。
**LLM品質の最終検証は実録画ケースで行うこと。**

### 実録画ケースの追加方法

1. `eval/dataset/<case-id>/` を作成し、`video.mp4` を配置
2. `ground_truth.json` を人手で作成（スキーマは phase-0 ドキュメント参照）。
   最初はステップ境界+タイトルのみの簡易正解でよい
3. `meta.json` に `synthetic: false`、`video_sha256`（`shasum -a 256`）、入手方法、`has_narration`、`scenario_tags` を記録
4. 録画は自作のデモ操作のみ使用（権利・機密に注意）

Sprint 1 では実録画5本以上を要求する。`scenario_tags` は以下を実録画全体で最低1回ずつカバーする:

- `silent`
- `narrated`
- `form_input`
- `load_wait`
- `modal_or_dropdown`

`pnpm eval:audit` は、実録画5本、上記タグ、`eval/results/generated/<case-id>/steps.json`、`eval/g4/records/<case-id>.json` を確認する。現状確認だけで非ゼロ終了を避けたい場合は `pnpm eval:audit -- --allow-incomplete` を使う。

Sprint 1の5ケースは、`real-app-workflow-01` の自作画面収録から意味単位のサブクリップを切り出した派生ケースを含む。`real-app-workflow-05-narrated-create-project` は画面内容は実録画だが、音声はmacOS `say` で作成した合成ナレーションを重ねている。人間が話しながら収録した素材ではないため、ナレーション品質を判断するときはこの制約を明示する。現時点の生成artifactはASRなしで作成されているため、ASR経路の品質確認には `ASR_PROVIDER=openai` または `local_whisper` での再生成が別途必要。

## メトリクス

実装: [server/eval/metrics.ts](../server/eval/metrics.ts)（単体テスト付き）

- **G1**: ステップ分割F1（区間IoU≥0.5の貪欲1対1マッチング）
- **G2**: UIラベル正確性（「」『』引用と `cited_ui_labels` の照合。引用0件ステップは分母除外、無引用率を併記）
- **G3**: 非ステップ混入率
- **境界Recall**: evidence.json のセグメント境界に対する正解境界の一致率（Phase 1 用）
- **G4**: 人手修正コスト（自動化対象外。出荷判断時に記録）

G4の記録フォーマットは [eval/g4/README.md](./g4/README.md) と [eval/g4/template.json](./g4/template.json) を参照。

## Sprint 4 Export QA

`pnpm eval:export-case -- --case <case-id>` は、ローカルに存在する `eval/dataset/<case-id>/video.mp4` と `eval/results/generated/<case-id>/steps.json` からPPTX、MP4、`qa-summary.json` を `eval/results/export-qa/<case-id>/` に生成する。動画と `eval/results/` はgitignore対象なので、新規環境では `meta.json` の `regenerate_command` や `pnpm pipeline:generate` で入力を先に復元する。恒久記録は `eval/g4/records/<case-id>.json` と `docs/roadmap.md` に残す。

`qa-summary.json` は入力steps/videoのSHA-256一致、PPTXの表紙/完了スライド/スピーカーノート警告数、MP4の長さ/音声ストリーム有無/音声内容/title card生成状況を記録する。ffmpegに `drawtext` がない、またはフォント指定が通らない環境では、動画のintro/outro title cardをスキップしてwarningに残し、ステップクリップ本体は生成を継続する仕様とする。

## Sprint 2 Quality Gate

`pnpm eval:quality-gate` は実録画ケースだけを対象に、現在の `eval/results/generated/<case-id>/steps.json` と `eval/baseline.json` を比較する。以下を満たす場合にPASSする:

> **前提**: `eval/results/generated/<case-id>/steps.json` が存在する必要がある。`eval/results/` はgitignore対象なので、新しい環境では先にpipeline runまたは既存artifactの復元で生成物を用意する。

- G2がbaselineから退行していない
- 5ケース平均G3が `10%` 以下で、baselineから退行していない
- `review_reasons` に `fallback:*` が混入していない

このgateは品質回帰とfallback混入の検出用であり、`ai_estimate` のG4や合成ナレーション派生ケースの制約を解消するものではない。

任意の候補 `steps.json` を現行artifactと比べる場合は
`pnpm eval:candidate -- --current-generated` を使う。低G3化をpromote条件に
含める場合は `--require-current-g3-improvement`、G2退行を禁止する場合は
`--max-current-g2-regression 0` を併用する。
