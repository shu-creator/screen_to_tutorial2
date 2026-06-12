# Phase 5: 負債整理（単一ソース化・ストリーミング・死にコード削除）

ステータス: 未着手
規模: M
依存: Phase 2 以降いつでも着手可。ただし 5.1 は Phase 3/4 のファイル改修と衝突しやすいため実施タイミングを調整する

## 目的

刷新で不要になった旧経路・移行期の二重管理・既知の運用上の罠を整理し、実装とドキュメントを一致させる。

## スコープ

### 5.1 steps.json 単一ソース化
- 現状: DB `steps` テーブルと steps.json の二重管理。編集・削除・並べ替え・再生成のたびに両方を同期（`stepsArtifact.ts` / `routers.ts`）。`persistStepsToDb()` はdelete&insertでstep IDが変わり、`audioUrl` 等の紐付けが切れる経路がある
- 変更:
  - steps.json v2 を唯一の真実とし、編集系ルートは artifact のみを更新
  - DB `steps` は読み取り表示用のミラーに縮退（artifact更新時に再構築）するか、クライアントが artifact を直接読む形に変更してテーブル自体を非推奨化。**どちらにするかはPhase 3/4完了後のクライアント実装を見て決定**（tRPCの既存クエリ互換を優先）
  - 音声ファイル（audioUrl/audioKey）の紐付けは `step_id`（artifact側の安定ID）基準に統一し、再生成時に音声が失われない/孤児にならないようにする

### 5.2 アップロードのディスクストリーミング
- 現状: `uploadRoute.ts` は「streaming to avoid memory issues」とコメントしつつ chunks 配列に最大500MBをメモリバッファ。`videoProcessor` / `asr` も動画全体を Buffer で読む（NFR-5違反）
- 変更:
  - busboy のファイルストリームを一時ファイルへ pipe し、検証（`fileValidator`）はファイル先頭バイトで実施後、ストレージへムーブ
  - `readBinaryFromSource` に「ローカルパスをそのまま返す/ストリームを返す」系のAPI（`resolveToLocalFile`）を追加し、動画系処理（ffmpeg入力）はバッファ経由を廃止

### 5.3 旧経路・死にコードの削除
- `scripts/extract_frames.py` を削除（未参照。`videoProcessor` はffmpeg直接実行）。`requirements.txt` の opencv 依存も、Phase 1 のOCR/抽出実装で使わないなら削除
- Phase 1 で残したシーン検出フォールバック経路を削除（evidence パイプラインの安定確認後）
- Phase 3 で退役決定したヒューリスティックの残骸確認
- 旧 `analyzeFrame()` 単フレーム解析（`regenerateStep` が使う場合は v2 の文脈付き再生成に置き換え）

### 5.4 ドキュメント整合
- README の「実装済み機能」リスト中に「CLI」セクションが割り込んでいる崩れ（README.md:282 付近）を修正
- README のプロジェクト構造・データベーススキーマ・パイプライン説明を刷新後の実態に更新
- `.env.example` を新パラメータ（サンプリングfps、coalescing、ASRリード、クリップ設定等）込みで再整理
- docs/plans 各ファイルのステータス更新、本ロードマップの完了記録

## 受け入れ基準

- [ ] 編集・並べ替え・削除・再生成・音声再生成のすべてが artifact 単一更新で完結し、既存UIが動作する（回帰テスト追加）
- [ ] 500MB級ファイルのアップロード時にプロセスRSSが入力サイズに比例して増えないことを確認（計測値を記録）
- [ ] `git grep` で旧経路（シーン検出、extract_frames.py、退役ヒューリスティック）への参照がゼロ
- [ ] README / .env.example / docs が実装と一致（手動チェックリストをPRに添付）
- [ ] `pnpm check` / `pnpm test` / `pnpm eval` がすべて通り、評価値がPhase 4完了時点から退行していない

## リスク

| リスク | 対応 |
|--------|------|
| 単一ソース化でtRPC API互換が崩れクライアント改修が膨らむ | 既存クエリのレスポンス形を維持するアダプタを挟む。クライアント大改修はしない |
| 既存プロジェクト（v1 artifact + DB steps）の移行漏れ | 読み込み時マイグレーション（Phase 2実装）を移行の唯一の入口とし、一括バッチ移行はしない |
