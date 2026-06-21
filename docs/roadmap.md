# ロードマップ: パイプライン刷新

最終更新: 2026-06-21
前提: [要件定義](./requirements.md) を参照。フェーズ詳細は `docs/plans/` を参照。

## Sprint 0 現状固定（2026-06-20）

- `4b55ae2`（waitingセグメントをステップのクリップ範囲から除外）は、`main` が `origin/main` より1コミット先行している現HEAD。push判断: ローカル検証後にpush候補。ただしCodexからの `git push` は行わず、ユーザー手動push対象とする。
- `scripts/model-rematch.ts` を再戦用の正式な作業台として採用する。`pipeline:generate` と `pnpm eval` をモデル別・run別に実行し、`eval/results/rematch*/summary.json` / `summary.md` に比較結果を残す。
- 再戦結果の暫定判断は `gpt-5.4` 維持。`eval/results/rematch/summary.json` 再生成後の有効run平均で `gpt-5.4` は G2引用精度が `95.8%`、`gpt-5.5` は520由来のinvalid runを除いて `78.6%`。再補充後の `eval/results/rematch-retry-5.5b/summary.json` でも `gpt-5.5` は `78.6%`。G2を主品質指標として `gpt-5.4` を既定モデルに据え置く。
- `gpt-5.5` の520/429やfallback-heavy runは比較不可runとして扱う。runのexit codeだけで成功判定せず、`needs_review` 比率（既定しきい値80%超）、G2引用精度、no-citation率、pipeline/eval logの `LLM invoke failed` / `520` / `429` / `insufficient_quota` を確認する。
- Sprint 1以降は、単一実録画 `real-app-workflow-01` から5ケース評価へ拡張し、G1/G2/G3に加えてG4（人手修正箇所数）を記録する。

### Sprint 1-5 受け入れ条件

| Sprint | 主目的 | 完了条件 |
|---|---|---|
| 1 | 評価セットを完成判定に耐える形へ拡張 | 無音、ナレーション付き、フォーム入力、ロード待ち、モーダル/ドロップダウンを含む実録画5ケースで `pnpm eval` がG1/G2/G3を出す。G4と人手修正箇所数の記録フォーマットを決め、baselineをマシン依存前提で再較正する。 |
| 2 | 生成品質の最後の詰め | 5ケース平均でG3低位維持、G2退行なし、fallback混入ゼロ。LLM API 520/429や `needs_review` 比率80%超のfallback-heavy runはinvalid扱いにし、retry/timeout/summaryと `needs_review` 理由追跡を堅牢化する。 |
| 3 | 編集UXを完成 | 生成後に人手で出荷可能状態まで直せる。`needs_review` レビュー導線、`t_start` / `t_end` 編集、ステップ単位の音声モード、タイトル・説明・ナレーション編集とartifact同期を確認する。 |
| 4 | PPTX/動画の出力QA | 評価ケース2本以上でPPTXと動画を目視QAし、G4を記録する。表紙、完了スライド、スピーカーノート警告、音ズレ、長尺ステップ、無音/元音声/TTS、drawtextなし環境を仕様化する。 |
| 5 | 負債整理とv1完成 | 新規環境でセットアップから生成まで通る。`steps.json` 単一ソース化の最終判断、旧フォールバック/未使用ヒューリスティック/古いdocs整理、`.env.example`、README、セットアップ手順、最小リリースチェックリストを更新する。 |

## Sprint 1 進捗（2026-06-20）

- `pnpm eval:audit` を追加し、実録画5本、必須 `scenario_tags`、生成済み `steps.json`、G4記録の有無を機械判定できるようにした。
- G4の人手修正箇所数フォーマットを `eval/g4/README.md` と `eval/g4/template.json` に固定した。
- `real-app-workflow-01` から意味単位の実録画サブクリップを切り出し、評価対象を5ケースへ拡張した。`real-app-workflow-05-narrated-create-project` は実画面収録にmacOS `say` の合成ナレーションを重ねた派生ケースであり、人間ナレーション実録画ではない。
- 5ケース全てで `eval/results/generated/<case-id>/steps.json` と `eval/g4/records/<case-id>.json` を用意し、`pnpm eval` でG1/G2/G3が出ることを確認した。G4記録は `review_type: "ai_estimate"` のartifact-only見積もりであり、人間が実修正した `human_review` 記録ではない。
- `pnpm eval -- --save-baseline` で、現在のマシン・生成artifact前提の `eval/baseline.json` を再較正した。
- G2は `title` / `operation` / `instruction` の引用に加え、structured artifact の `cited_ui_labels` も照合するようにした。再較正後の実録画5ケースG2は `72.2%` / `88.9%` / `41.7%` / `55.6%` / `88.9%`。
- 現在の `pnpm eval:audit` 結果はPASS。Sprint 1の機械監査条件は満たしたが、ナレーションケースは合成音声派生で、現環境ではASR付きpipeline再生成は未実施（`whisper` なし、`OPENAI_API_KEY` 未設定）。G4もAI見積もりであるため、後続QAでは人間ナレーション実録画や人手修正済みG4と混同しない。

## Sprint 2 進捗（2026-06-20）

- `needs_review` の理由を `review_reasons` として `steps.json` に保存するようにした。`warnings` は人間向け文面として維持し、`review_reasons` は `fallback:chunk_authoring_failed` / `fallback:unassigned_segment` / `fallback:legacy_step_analysis_failed` / `verification:unverified_ui_label` / `verification:low_confidence` などの理由コードとして扱う。
- APIと `scripts/model-rematch.ts` のsummaryで `review_reasons` を追えるようにした。UIの要レビューバッジとPPTXスピーカーノートは、配布・レビュー時に読めるよう人間向け `warnings` の表示を維持する。
- 既存artifactとの後方互換のため、v1/v2読み込み時に `review_reasons: []` を補完する。
- `pnpm eval:quality-gate` を追加し、実録画5ケースのG2退行、平均G3上限/退行、`fallback:*` review reason混入を機械判定できるようにした。現状はローカルの `eval/results/generated/<case-id>/steps.json` が存在する前提で、G2平均 `69.4%`、G3平均 `7.0%`、fallback reason `0` でPASS。
- `scripts/model-rematch.ts` に `--timeout-seconds` を追加し、pipeline/eval command timeoutをログとsummaryに残せるようにした。520/429/insufficient_quota/all-fallbackに加えて `command_timeout` もinvalid signalとして拾う。
- 現時点のSprint 2機械gateはPASS。ただし、品質そのものは低いケース（例: `real-app-workflow-03-generate-steps` のG2 `41.7%` / G3 `25.0%`）が残るため、生成品質改善は継続対象。

## Sprint 3 進捗（2026-06-20）

- ステップ編集UIから `t_start` / `t_end`（ms）を編集できるようにし、`steps.json` artifactへ同期するようにした。DBには該当列がないため、タイミングはartifactを単一の編集先とする。
- ステップ単位の `audio_mode`（`auto` / `tts` / `original` / `mixed` / `silent`）を `steps.json` に保存し、動画生成時はステップ指定が全体音声モードより優先されるようにした。
- 既存artifactとの後方互換のため、`audio_mode` 欠落時は `auto` を補完する。
- 要レビュー件数、次の要レビューを編集する導線、ステップ単位のレビュー済み操作を追加した。レビュー済みにするとartifactの `needs_review` / `review_reasons` / `warnings` をクリアする。
- これは編集UXの主要操作を揃えた状態だが、生成後に実際に人手で出荷可能状態まで直す通しQAは未実施。

## Sprint 4 進捗（2026-06-20）

- `pnpm eval:export-case` を追加し、ローカルに存在する評価ケースの `video.mp4` と `eval/results/generated/<case-id>/steps.json` からPPTX、MP4、`qa-summary.json` を `eval/results/export-qa/<case-id>/` に生成できるようにした。DB状態に依存せず、Sprint 4の出力QAを再実行できる作業台とする。ただし動画と `eval/results/` はgitignore対象なので、新規環境では `meta.json` の `regenerate_command` や `pnpm pipeline:generate` による入力復元が先に必要。
- `real-app-workflow-04-export-video` と `real-app-workflow-05-narrated-create-project` の2ケースでPPTX/動画を生成した。`qa-summary.json` では入力steps/videoのSHA-256一致、PPTX表紙、完了スライド、スライド数、スピーカーノート警告数、動画長、音声ストリーム有無、音声内容を記録する。
- 代表確認: 2ケースのMP4から5秒時点のフレームを抽出して非空の元録画クリップを確認。`real-app-workflow-05-narrated-create-project` はPPTXをsofficeでPDF化し、表紙/ステップ/完了スライドを画像化して読み取り可能なことを確認した。
- `drawtext` なし、またはフォント指定が通らない環境では、動画intro/outro title cardをスキップしてwarningに残し、ステップクリップ本体は生成継続する仕様とした。現環境ではtitle card 2件がskipされ、両ケースともstep clipsは生成された。
- G4記録の `exported_artifacts` とnotesを2ケース分更新した。ただし `review_type` は `ai_estimate` のままであり、人間が出荷可能状態まで直した `human_review` ではない。

## Sprint 5 進捗（2026-06-20）

- `.env.example` とREADMEの既定 `LLM_MODEL` を `gpt-5.4` に揃えた。
- `pnpm setup:check` を追加し、新規環境のプリフライトとして Node.js / pnpm / ffmpeg / ffprobe / 主要npm scripts / `.env.example` / セットアップdocsの存在を確認できるようにした。
- `docs/setup-local.md` を追加し、依存関係、`.env`、DB初期化、`pipeline:generate` による生成スモーク、評価/出力QA、開発サーバー起動までの手順を固定した。
- `docs/v1-release-checklist.md` を追加し、v1 tag前に必要な検証、添付証跡、既知の非blocking caveatを整理した。
- `steps.json` 単一ソース化の最終判断: v1では全面移行しない。artifact-firstで読み書きしつつ既存DB `steps` テーブル同期互換を維持し、DB縮退・安定 `step_id` 基準の音声紐付け全面移行・旧単フレーム再生成退役はpost-v1に回す。
- ローカル既存環境で `eval/dataset/synth-login-click-01/video.mp4` を使った生成スモークを実施した。`pnpm pipeline:generate --video eval/dataset/synth-login-click-01/video.mp4 --outdir outputs/v1-smoke --use-audio false --asr-provider none --ocr-provider none --max-frames 12` で `outputs/v1-smoke/project_28_steps.json` を生成し、`pnpm project:export -- --project-id 28 --audio-mode silent --outdir outputs/project-export` でPPTX/動画summaryを生成した。
- スモーク証跡: `project_28_steps.json` SHA-256 `2e752ae86dd7e89b55c06425de73a3a0b96bf292cff1910209a08053689969c9`。`project_28_export_summary.json` は再実行ごとにtimestampと出力URLが変わるため固定SHAは記録しない。直近runではPPTX 154503 bytes、MP4 72262 bytes、`slide.content_check.status=pass`、`total_slide_count=6`、`slides_with_images=3`、`media_image_count=3`、`expected_step_image_count_source=steps_artifact`、`placeholder_text_hits=[]`、動画 `still_image_fallback_count=0`。
- `pnpm edit:smoke -- --project-id 28 --outdir outputs/edit-smoke` を追加し、DB stepのタイトル/操作/説明/ナレーションと、`steps.json` artifactのタイトル/操作/説明/ナレーション/`t_start` / `t_end`/ステップ音声モード/レビュー済み状態の同期を一時編集で確認できるようにした。直近runは `pass=true`、`restored_after_check=true`、`restore_error=null`。
- `pnpm v1:smoke -- --video <sample.mp4> ...` を追加し、`setup:check`、`pipeline:generate`、`project:export`、`edit:smoke` を1コマンドで実行して `v1_smoke_summary.json` に集約できるようにした。既存ローカル環境で `eval/dataset/synth-login-click-01/video.mp4` を使った直近runは project 32、`pass=true`、既定 `ocr_provider=none`、steps SHA-256 `ffd61bc1e3fff231f764d26a6d59d86cb137c7b5120cea10fc88e5c744c6a945`、`step_count=3`、`needs_review_count=3`、`fallback_reason_count=0`。
- `pnpm v1:release-audit` を追加し、v1リリース条件を `release.docs` / `model.default` / `eval.readiness` / `eval.quality_gate` / `smoke.current_environment` / `export.qa` / `g4.human_review` / `smoke.fresh_environment` に分けて監査できるようにした。初期runは `INCOMPLETE` だったが、G4 human reviewとfresh-env smoke証跡を追加後、`v1.0.0` タグ時点ではPASS。
- `pnpm v1:fresh-env-smoke` を追加し、HEADから一時チェックアウトを作成して依存インストール後に `v1:smoke` を実行し、`outputs/v1-fresh-env-smoke/v1_smoke_summary.json` へ `environment.kind=fresh_checkout` と実行command証跡を残せるようにした。依存インストールを伴うため実行には `--allow-install` が必須。
- 最終v1証跡は `outputs/v1-fresh-env-smoke/v1_smoke_summary.json` と `outputs/v1-smoke-default-check/v1_smoke_summary.json`。設定値は `LLM_MODEL=gpt-5.4`。OCRなしの生成スモークで `needs_review=3/3` だが、fallback reasonは0で、PPTXの画像/placeholder検査、export QA、edit smoke、fresh checkout証跡はrelease auditでPASS。

## 全体像

```
現行:  シーン検出フレーム ──► 1フレーム=1ステップを独立LLM解析 ──► steps.json ──► スライド/紙芝居動画

目標:  密サンプリング+変化点検出          一括LLM執筆(統合/分割/破棄)
       ┌──────────────────┐   ┌──────────────────────┐
動画 ──►│ Phase 1: 証拠抽出   │──►│ Phase 2: ステップ執筆      │──► steps.json v2
       │ evidence.json      │   │ +UIラベル機械検証          │      │
       └──────────────────┘   └──────────────────────┘      ├──► Phase 3: スライド
                ▲                                                  └──► Phase 4: クリップ動画
                │
       Phase 0: 評価基盤（全フェーズの改善を測る物差し。最初に作る）
```

## フェーズ一覧

| Phase | 内容 | 規模 | 依存 | 状態 | 詳細プラン |
|-------|------|------|------|------|-----------|
| 0 | 評価基盤 + ベースライン測定 + 早期改善実験 | M | なし | 実装済み（v1で5ケース監査PASS） | [phase-0](./plans/phase-0-eval-harness.md) |
| 1 | 証拠抽出パイプライン刷新（evidence.json） | L | 0 | 実装済み | [phase-1](./plans/phase-1-evidence-extraction.md) |
| 2 | ステップ執筆の一括化 + 機械検証（steps.json v2） | L | 1 | 実装済み（v1品質gate PASS、低G2改善はpost-v1） | [phase-2](./plans/phase-2-step-authoring.md) |
| 3 | スライド品質改善 + ヒューリスティック退役 | M | 2 | 実装済み（退役は一部保留） | [phase-3](./plans/phase-3-slide-quality.md) |
| 4 | クリップベース動画生成 | M | 2 | 実装済み | [phase-4](./plans/phase-4-clip-video.md) |
| 5 | 負債整理（単一ソース化・ストリーミング・死にコード削除） | M | 2 | 実装済み（5.1単一ソース化は保留） | [phase-5](./plans/phase-5-consolidation.md) |

**v1固定点（2026-06-21）**: `v1.0.0` は `e034c9cc3b9938ea91931d2f520f77e79080682c` を指す。`pnpm v1:release-audit` はPASSし、実録画5ケースの `eval:audit`、`eval:quality-gate`、export QA、2件のhuman G4、fresh-env smokeが揃っている。残タスクはpost-v1扱い: (1) G2が低いケースの改善、(2) Phase 3系ヒューリスティックの退役判断、(3) confidence式の較正、(4) 5.1の単一ソース化判断。

規模感: S = 1セッション程度 / M = 数セッション / L = 大きめ・PR複数に分割推奨

## 実施順序と判断ポイント

1. **Phase 0 を必ず最初に行う。** 物差しなしの改善は判断不能。Phase 0 には「差分bbox+前フレームを現行プロンプトに注入する」低コスト実験が含まれており、この結果が Phase 2 のプロンプト設計の根拠になる。
2. **Phase 1 → 2 は直列。** evidence.json のスキーマが執筆フェーズの入力契約になるため。
3. **Phase 3 と 4 は Phase 2 完了後に並行可能。** どちらも steps.json v2 を読むだけで相互依存がない。優先順位は同等（オーナー決定）なので、着手順は Phase 2 完了時点の品質課題の大きい方から選ぶ。
4. **Phase 5 は Phase 2 以降ならいつでも着手可能。** ただし二重管理の解消（5.1）は Phase 3/4 の改修と衝突しやすいため、同一ファイルを触るタイミングを避けて計画する。
5. **各フェーズの完了条件に「`pnpm eval` でベースライン比の数値を記録する」を含める。** 悪化していたらマージしない。

## マイルストーン

| マイルストーン | 達成条件 |
|---------------|---------|
| M1: 測れる | 評価セット5本以上 + `pnpm eval` がベースライン数値を出力する |
| M2: 証拠が揃う | 評価セット全件で evidence.json が決定的に生成され、セグメント境界Recall（正解境界がセグメント境界と一致する率。phase-1参照）がベースライン以上 |
| M3: 文章が信頼できる | steps.json v2 生成でG1/G2/G3すべてベースライン超え。UIラベル機械検証が稼働 |
| M4: 成果物が出る | スライド・クリップ動画とも v2 から生成され、評価セットでの人手修正箇所数（G4）が記録される |
| M5: 負債ゼロ | 二重管理解消・死にコード削除・README/docsが実装と一致 |

## リスクと対応方針

| リスク | 影響 | 対応 |
|--------|------|------|
| 評価セット作成の人手コストが想定超過 | Phase 0 遅延 | 最初は3本+簡易正解（ステップ境界とタイトルのみ）で開始し、漸進的に拡充 |
| 一括執筆のコンテキスト超過（長尺・多ステップ動画） | Phase 2 設計変更 | チャンク分割+概要の引き継ぎ方式を最初から設計に含める（phase-2参照） |
| PaddleOCR のセットアップ問題（環境差） | Phase 1 摩擦 | LLM-OCRフォールバックを契約として保証。OCRエンジンはアダプタ化 |
| クリップ切り出しの品質（無関係な操作の映り込み） | Phase 4 品質 | t_start/t_end のトリミング規則を評価セットで調整。静止画フォールバック維持 |
| 現行ユーザーデータ（既存プロジェクト）の互換性 | 移行 | steps.json v1→v2 は読み込み時自動マイグレーション。DBスキーマ破壊変更はしない |

## 進捗管理

- フェーズごとに GitHub Issue を立て、PR は本ロードマップのフェーズ番号を参照する
- 各フェーズ完了時に `docs/plans/` の該当ファイル冒頭ステータスを更新する
