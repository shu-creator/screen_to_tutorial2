# Phase 2: ステップ執筆の一括化 + 機械検証（steps.json v2）

ステータス: 実装済み（2026-06-12）。実装メモ:
- `server/authoring/`（digest / author / verification）として実装。LLM呼び出しはチャンク数回のみ
- 機械検証・フォールバック・チャンク執筆・暫定overview引き継ぎ・retry時のartifact無効化まで実装済み
- LLM部分はモック（vi.mock）でテストし、v1.0.0時点では実録画5ケースの `pnpm eval:quality-gate` がPASS
- confidence式の係数較正（実G2との相関確認）はpost-v1の改善対象

## Historical Notes

- 2026-06-12時点では、実LLMでの出力品質確認、G1/G2/G3の実測、confidence式の係数較正は実データ待ちだった。

規模: L（PR 2本に分割推奨）
依存: Phase 1（evidence.json が入力契約）

## 目的

フレームごとの独立LLM解析を廃止し、タスク全体の証拠を一括で渡してステップを「執筆」させる。生成文の根拠（UIラベル）は機械照合で検証し、信頼できないステップをユーザーに可視化する。

## 現状の問題（置き換え対象）

- `stepGenerator.ts` のループが1フレームずつ `analyzeFrame()` を呼び、LLMはタスク全体・前後関係・差分bboxを知らない（C1/C2/C3）
- ステップの統合・分割・破棄ができず、スクロールや待機画面もステップ化される
- 「OCRにないラベルを推測しない」はプロンプト上のお願いで、検証がない。confidence は未較正な自己申告とOCR confidenceの平均で、誰も消費しない（C7）
- ナレーションの文体・粒度がステップ間でバラつく

## 設計

### 2段構成

**Stage A: 証拠ダイジェスト（機械的・LLMなし）**
evidence.json から執筆用の入力を組み立てる:
- 各セグメント: after画像（必要に応じbefore画像も）のサムネイル、差分bbox、`ocr_focus`、`ocr_lines`（上限行数でトリム）、`transcript_snippet`、`coalesced_from`
- 全体: 動画の長さ、セグメント数、（あれば）transcript全文の要約用先頭部
- **フレーム参照マッピング**: 各セグメントの `after_frame.frame_id`（evidence側で必須）から steps.json v2 の `representative_frames`（`frame_id` + `image_url`）を構成する。`persistStepsToDb()` が `frame_id` 欠落で throw する契約（`stepGenerator.ts:196-199` 相当）を維持するため、ここで欠落を検出したら執筆前にエラーにする

**Stage B: 一括執筆（LLM 1〜2回）**
- 入力: Stage A のダイジェスト全体 + 執筆指示
- LLMに与える裁量:
  - 複数セグメントの**統合**（例: 連続入力 → 「氏名・メール・パスワードを入力する」）
  - セグメントの**破棄**（スクロールのみ・ロード待ち、`non_step` 判定）
  - 1セグメントの**分割**は原則させない（証拠の対応が崩れるため。分割が必要なケースはPhase 1のセグメンテーション課題として扱う）
- 出力（json_schema strict）:
  - `overview`: タスク名・前提・完了条件
  - `steps[]`: `source_segment_ids[]`（根拠セグメント、必須）、title / instruction / expected_result / operation / description / narration / cited_ui_labels[] / confidence
- ナレーションは overview を踏まえた通し文体で生成（「まず」「次に」「最後に」の接続が破綻しない）。チャンク分割時は最初のチャンクで暫定 overview を生成して以降のチャンクに引き継ぎ、最終パスで確定 overview に更新する（ナレーション本文の書き直しはしない）

### 長尺対応（コンテキスト超過対策）

- セグメント数が閾値（目安40、env化）を超える場合はチャンク分割し、各チャンクに「前チャンクまでの確定ステップの要約」を引き継いで逐次執筆
- 最後に overview のみ再生成パスを1回走らせ、全体整合を取る

### 機械検証（LLM出力の後処理・決定的）

1. **UIラベル照合**: `cited_ui_labels` の各ラベルを、該当 `source_segment_ids` の `ocr_lines ∪ ocr_focus` と照合（正規化: 空白・全半角・大文字小文字）。不一致ラベルは `warnings` に追加し confidence を減点
2. **根拠整合**: `source_segment_ids` が空・重複・順序逆転していないか検証。違反は不採用とし、当該セグメントから単独ステップを機械生成（現行のフォールバックステップ方式を流用）
3. **較正済みconfidence**: LLM自己申告は使わず、`検証通過ラベル率 × OCR confidence × (transcript有無の係数)` の決定的な式で算出。式は評価セットのG2と突き合わせて較正
4. **レビューキュー**: confidence が閾値未満のステップに `needs_review: true` を付与

### steps.json v2 スキーマ（v1からの差分）

```jsonc
{
  "version": "2.0",   // 現行の STEPS_ARTIFACT_VERSION = "1.0"（文字列）に合わせ文字列で統一
  "overview": { "task_title": "...", "preconditions": ["..."], "completion_criteria": "..." },
  "steps": [
    {
      // v1から維持: step_id, sort_order, t_start, t_end, title, operation,
      //             description, narration, instruction, expected_result,
      //             warnings, confidence, representative_frames, changed_region_bbox,
      //             frame_id, audio_url, audio_key, legacy_step_db_id
      //   - audio_url/audio_key: 音声生成（videoGenerator の patchStepArtifact）が依存
      //   - legacy_step_db_id: 編集・再生成・並べ替えルート（routers.ts）のマッチングキー
      //   いずれも Phase 5 の単一ソース化まで必須で維持する
      "source_segment_ids": ["seg-3", "seg-4"],   // 新規: evidence.json への根拠リンク
      "cited_ui_labels": ["保存"],                  // 新規: 機械照合済みラベル
      "needs_review": false                         // 新規
    }
  ]
}
```

- v1 読み込み時は自動マイグレーション（`source_segment_ids: []`、`needs_review: false` 等のデフォルト埋め）
- **マイグレーションの入口を厳格化**: 現行 `loadStepsArtifact` はパース失敗を握りつぶして null を返すため（`stepsArtifact.ts:86-88` 相当）、旧コードがv2を読むと「artifactなし」として静かにDBへフォールバックする。v2実装では「既知バージョンはマイグレーション、未知バージョンは警告ログ+エラー」とし、サイレントなnullフォールバックを禁止する
- DB `steps` への同期（`persistStepsToDb`）は当面維持（解消は Phase 5）

### UI変更（最小限）

- ステップ一覧に `needs_review` バッジと warnings 表示を追加
- overview の表示・編集欄を追加（スライドの表紙・動画のイントロに使用）

## タスク分解（PR分割案）

1. **PR-A: 執筆コア** — Stage A/B、チャンク分割、steps.json v2 スキーマ + v1マイグレーション、機械検証、フォールバック。`pnpm eval` でG1/G2/G3をベースライン比較
2. **PR-B: UI対応 + ルート互換** — needs_review バッジ、overview 編集、編集系ルート（edit/delete/reorder/regenerate）の v2 対応。加えて:
   - **retry ルート**: 現行 `project.retry` はフレームとDB stepsを削除するが steps.json を残置するため、古いartifactが削除済みフレームを参照したまま生成に使われる経路がある。retry時に steps.json / evidence.json を無効化（削除またはバージョンマーク）する処理を追加
   - **duplicate / retry の互換テスト**: README が実装済みと謳う全プロジェクト操作（複製・再試行含む）が v2 で動作することを回帰テストに含める

## コスト見積もり

- 現行: フレーム数N × 2回（OCR + 解析）のマルチモーダル呼び出し（直列）
- 刷新後: OCRはローカル（Phase 1）、執筆は ceil(N/チャンクサイズ) 回 + overview 1回。N=40 なら **約80回 → 2回**
- 画像トークンが1リクエストに集中するため、サムネイル解像度（目安: 長辺768px）で調整。`detail: high` は差分bboxが小さいセグメントのみに限定する等の最適化はベンチ後に判断

## 受け入れ基準

- [ ] 評価セットでG1/G2/G3すべてベースライン超え（Phase 0の早期実験値も超えること）
- [ ] スクロールのみ区間が破棄される（G3改善）ことを評価ケースで確認
- [ ] UIラベル照合の単体テスト（正規化含む）が通る
- [ ] confidence と G2 の相関を評価レポートに記録（較正の根拠）
- [ ] v1 steps.json の既存プロジェクトが読み込み・編集できる（後方互換テスト）
- [ ] チャンク分割パスが長尺ケース（セグメント40超）で動作する

## リスク

| リスク | 対応 |
|--------|------|
| 一括執筆で個別ステップの画像注意が散漫になり、単フレーム解析より個別精度が落ちる | Phase 0 の早期実験（文脈注入の効果測定）で兆候を把握。悪化する場合は「一括で構成決定 → ステップごとに執筆（構成+前後文脈を渡す）」のハイブリッドに切り替える設計余地を残す |
| json_schema 大型出力の崩れ（プロバイダー差） | 既存 `invokeLLM` のプロバイダー抽象に strict schema を任せ、パース失敗時はチャンクを細分して再試行 |
| ナレーション文体が overview とズレる | 評価対象外だが、スライド/動画のレビュー（Phase 3/4）で目視確認項目に含める |
