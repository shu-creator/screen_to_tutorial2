# Phase 3: スライド品質改善 + ヒューリスティック退役

ステータス: 未着手
規模: M
依存: Phase 2（steps.json v2）。Phase 4 と並行可

## 目的

スライド生成を steps.json v2 で駆動し、上流品質の向上によって不要になった `slideText.ts` の対症療法ヒューリスティックを安全に退役させる。

## 現状の問題

- `slideText.ts`（465行）は上流生成の弱さをテキスト整形で補修している（C8）:
  - 画面内の「ステップ17」表記の匿名化（LLMがOCRテキストを盲目的に転記するため）
  - 末尾hoverステップの「完了確認」への差し替え（非ステップ混入のため）
  - 重複タイトルへの「（続き）」付与（独立解析で同じタイトルが量産されるため）
  - 文末欠け補完・文境界トリム（出力長制御が効かないため）
- これらは正規表現+キーワードリスト依存で brittle。Phase 2 後は原因側が解消されるため、残すと**正しい生成文を誤って書き換える**リスクに転化する
- 表紙スライドは存在する（`slideGenerator.ts:974` 付近、projectタイトル直書き）が、v2 の overview を使っておらず、目次・完了スライドが無い
- スライドのROI/spotlightは `slideGenerator.ts:510` 付近の**独自実装の `detectChangedRegion`**（ffmpeg blend+cropdetect）が生成のたびに再計算しており、アーティファクトの `changed_region_bbox` はどこからも消費されていない（`frameAnalysis.ts` 版との重複実装）

## 設計

### 1. v2 駆動への切り替え
- `slideGenerator.ts` の入力を v2 に切り替え:
  - `overview.task_title` / `preconditions` → 既存表紙スライドの内容を overview 駆動に差し替え
  - `steps[].cited_ui_labels` → 操作対象ラベルの強調表示（trainingプリセットのハイライトと連動）
  - `overview.completion_criteria` → 完了スライド（新規）
- ROI/spotlight の入力を slideGenerator 独自の `detectChangedRegion` 再計算から **artifact の `changed_region_bbox` 消費に置換**する（再計算コスト削減と evidence との整合。独自実装の削除自体は Phase 5）
- `needs_review: true` のステップにはスピーカーノートへレビュー警告を出力（配布前に気づける）

### 2. ヒューリスティック退役（測定駆動で段階的に）
退役は一括削除ではなく、評価セットのスライド出力を before/after 比較して1機能ずつ行う:

| ヒューリスティック | 退役条件 |
|---|---|
| `anonymizeOnScreenStepNumbers` | Phase 2 の機械検証でOCR転記が抑制されていることを評価ケースで確認後。投影用 `formatProjectionDetail`（`slideText.ts:406`）の内部でも呼ばれているため、退役時はそちらの改修も必要 |
| `applyFinalStepCompletionFix`（および未参照の `fixFinalStepIfHover`） | G3（非ステップ混入率）がベースライン比で十分低下後 |
| `buildDisplayTitleMap`（および未参照の `uniquifyTitles`） | 一括執筆でタイトル重複が解消されていることを確認後 |
| `truncateAtSentence` / `ensureTerminalPunctuation` | **維持**（レイアウト都合の行数制限は下流の責務として正当） |

- 退役したコードは削除（コメントアウト残しはしない）。対応する単体テストも削除し、退役判断の根拠（評価値）をPR説明に記録

### 3. レイアウト責務の整理
- 「生成品質の補修」と「レイアウト整形（文字数制限・改行）」を分離し、後者のみ `slideText.ts` に残す。ファイル名は実態に合わせ `slideLayoutText.ts` 等へ変更検討

## やらないこと

- 新規テンプレート/プリセットの追加（既存 default / training の維持のみ）
- PPTX以外の出力形式（PDF等）

## 受け入れ基準

- [ ] 評価セット全件でスライドが v2 から生成され、表紙・完了スライドを含む
- [ ] 退役した各ヒューリスティックについて、評価値に基づく退役根拠がPRに記録されている
- [ ] `needs_review` ステップがスピーカーノートで識別できる
- [ ] trainingプリセットの ROI/spotlight が artifact の `changed_region_bbox` を入力として動作し、出力が独自再計算時と同等以上（評価セットで目視比較）
- [ ] G4（人手修正箇所数）の記録を評価セット2件以上で実施

## リスク

| リスク | 対応 |
|--------|------|
| 退役が早すぎて品質退行 | 1機能ずつ・評価値を見ながら。退行したら復活ではなく上流（Phase 2 プロンプト/検証）を直す |
| v2切り替えで既存プロジェクトのスライドが変わる | v1自動マイグレーション経由で生成は可能。出力差分はリリースノートに明記 |
