# G4 人手修正コスト記録

G4 は自動計測しない。評価ケースごとに、生成後に出荷可能状態へ直すための人手修正箇所数を `eval/g4/records/<case-id>.json` に記録する。

`review_type` が `human_review` の記録だけを、出荷判定用の人手修正コストとして扱う。Codexなどによるartifact-only見積もりは `review_type: "ai_estimate"` と明記し、評価セット整備や傾向把握には使えるが、人間が実際に修正して出荷可能状態を確認したG4記録の代替にはしない。

## 記録タイミング

1. `pnpm pipeline:generate` で対象ケースの `steps.json` と成果物を生成する
2. UIまたはartifactを人手でレビューし、出荷可能状態まで修正する
3. 修正内容をカテゴリ別に数えて、`template.json` を複製して記録する
4. `pnpm eval:audit` で実録画ケース、生成済みsteps、G4記録の有無を確認する

`template.json` の `<case-id>`、`reviewer`、`reviewed_at`、`source_artifact` は必ず実値に置き換える。`pnpm eval:audit` は空テンプレートのままのG4記録を未達扱いにする。

CLIで記録する場合は `pnpm g4:record` を使う。`human_review` は人間が実際にレビューして出荷可能状態まで直した場合だけ記録するため、書き込みには `--confirm-human-review` が必須。

レビュー前の作業シートを作る場合は `pnpm g4:review-pack` を使う。これはPPTX/動画/steps/QA summaryを1つのMarkdownにまとめるだけで、`human_review` G4記録は書かない。

```bash
pnpm g4:review-pack -- \
  --case real-app-workflow-04-export-video \
  --case real-app-workflow-05-narrated-create-project \
  --overwrite
```

出力QA済みの実録画ケースから出荷判定用の候補を選ぶ場合は `--release-candidates` を使う。validなPPTX/動画QA summaryと成果物があり、まだ `human_review` G4が無いケースだけを既定2件選ぶ。

```bash
pnpm g4:review-pack -- --release-candidates --overwrite
```

既定出力は `outputs/g4-review-packets/<case-id>.md`。このMarkdownを見ながら人間がPPTX/動画/stepsを確認し、修正後に `pnpm g4:record -- --dry-run ...` で記録内容を確認する。

```bash
pnpm g4:record -- \
  --case real-app-workflow-04-export-video \
  --reviewer "<reviewer-name>" \
  --reviewed-at YYYY-MM-DD \
  --confirm-human-review \
  --dry-run \
  --title_edits 0 \
  --description_edits 0 \
  --narration_edits 0 \
  --timing_edits 0 \
  --citation_edits 0 \
  --step_structure_edits 0 \
  --export_artifact_edits 0 \
  --other_edits 0 \
  --notes "Human reviewed and corrected to shippable state."
```

`--dry-run` はJSONだけを表示し、ファイルを書かない。実際に `eval/g4/records/<case-id>.json` を置き換える場合は、内容を確認したうえで `--dry-run` を外し、既存recordがあるケースでは `--overwrite` も付ける。

## カウント規則

- 1つのステップでタイトルと説明を直した場合は `title_edits=1`、`description_edits=1`
- `t_start` と `t_end` を同じステップで直した場合は `timing_edits=1`
- ナレーション文の修正は `narration_edits`
- 引用UIラベルの追加・削除・置換は `citation_edits`
- 不要ステップの削除、ステップ分割、ステップ統合は `step_structure_edits`
- PPTX/動画の出力後にだけ見つかった修正は `export_artifact_edits`

`total_manual_edits` は上記カテゴリの合計。カテゴリ外の修正を数えた場合は `other_edits` に入れ、`notes` に理由を書く。
