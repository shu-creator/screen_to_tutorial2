# TutorialGen - 画面録画から説明動画を自動生成

操作動画をアップロードするだけで、AIが自動で手順を解析し、スライドと音声付きの解説動画を数分で作成できるWebアプリケーションです。

## 主な機能

### 1. 動画アップロードと操作セグメント抽出
- MP4/MOV形式の画面録画をアップロード（ディスクストリーミング、メモリ全載せなし）
- ピクセル差分率の状態機械による操作セグメンテーション（タイピング等の連続入力は自動で1操作に集約）
- 各セグメントに before/after 画像・変化領域bbox・OCR・発話を紐付けた `evidence.json` を生成

### 2. AIステップ執筆と構造化（2フェーズ生成）
- **証拠抽出**（決定的・LLMなし）→ **一括執筆**（証拠全体をLLMに渡しステップの統合・破棄を裁量）
- UIラベル引用はOCR実測と機械照合し、不一致は警告+要レビューとしてマーク
- マニュアル全体の概要（タスク名・前提・完了条件）も生成
- 出力は `steps.json` v2（中間表現）。スライド/動画はこれを優先して生成
- 各ステップ: タイトル / 操作 / 説明 / ナレーション原稿 / instruction / expected_result /
  根拠セグメント / cited_ui_labels / confidence / needs_review

### 3. ステップ編集機能
- 抽出されたステップのテキスト編集
- ステップの並べ替え
- ステップの削除

### 4. スライド生成
- PowerPoint（PPTX）形式でスライドを自動生成
- 各スライドには以下が含まれます：
  - ステップ番号とタイトル
  - 操作画面のスクリーンショット
  - 操作説明と詳細説明
  - スピーカーノート（ナレーション原稿）
- `SLIDE_PRESET=training` で研修投影向けレイアウト（文字大きめ・自動ROI・spotlight）を利用可能

### 5. 音声合成と動画生成
- **元録画のクリップ切り出し + ナレーション**による解説動画（MP4）
- 音声モード: 自動 / TTS / 元録画の音声 / ミックス / 無音
- overview駆動のイントロ・アウトロカード、クリップ不可時は静止画フォールバック

### 6. ASR / OCR グラウンディング
- `ASR_PROVIDER` で音声文字起こし（none/openai/local_whisper）を切替。発話は操作に先行する前提のリードウィンドウで割り当て
- `OCR_PROVIDER=engine` でローカルOCRエンジン（PaddleOCR/Tesseract自動選択、無ければLLM-OCRへフォールバック）
- OCR/Transcript/差分bboxを執筆プロンプトに注入し、引用ラベルは機械検証してハルシネーションを抑制

### 7. 評価ハーネス
- `pnpm eval` でステップ分割F1・UIラベル正確性・非ステップ混入率・セグメント境界Recallを測定
- 合成評価データセットを `pnpm eval:dataset` で決定的に再生成可能（詳細: [eval/README.md](./eval/README.md)）

## 技術スタック

### フロントエンド
- React 19
- Tailwind CSS 4
- shadcn/ui
- tRPC
- Wouter（ルーティング）

### バックエンド
- Node.js + Express
- tRPC 11
- Drizzle ORM
- MySQL/TiDB

### 画像・動画処理
- FFmpeg（サンプリング・クリップ切り出し・差分解析）
- PaddleOCR / Tesseract（ローカルOCR、任意）
- PptxGenJS

### AI・機械学習
- マルチLLMプロバイダー統合（OpenAI/Gemini/Claude）
- マルチTTSプロバイダー統合（OpenAI/Gemini）

### インフラ
- ローカルファイルシステム（ファイルストレージ）
- OAuth 2.0（認証）

## プロジェクト構造

```
screen_to_tutorial/
├── client/                 # フロントエンドコード
│   ├── src/
│   │   ├── pages/         # ページコンポーネント
│   │   ├── components/    # 再利用可能なUIコンポーネント
│   │   └── lib/           # tRPCクライアント等
├── server/                # バックエンドコード
│   ├── routers.ts         # tRPCルーター
│   ├── db.ts              # データベースクエリヘルパー
│   ├── videoProcessor.ts  # 動画処理オーケストレーション
│   ├── evidence/          # 証拠抽出（セグメンテーション・evidence.json）
│   ├── authoring/         # 一括ステップ執筆 + 機械検証
│   ├── stepGenerator.ts   # ステップ生成エントリポイント
│   ├── slideGenerator.ts  # スライド生成
│   ├── videoGenerator.ts  # 動画・音声生成
│   ├── videoClips.ts      # クリップ切り出し・音声調停
│   └── eval/              # 評価メトリクス・ランナー
├── drizzle/               # データベーススキーマ
│   └── schema.ts
├── eval/                  # 評価データセット・合成データ生成
├── scripts/
│   └── ocr_server.py      # ローカルOCRエンジンサーバー
```

## データベーススキーマ

### users
ユーザー情報を管理

### projects
動画処理プロジェクトを管理
- タイトル、説明
- 動画URL、ステータス

### frames
抽出されたキーフレームを管理
- フレーム番号、タイムスタンプ
- 画像URL、差分スコア

### steps
AI生成されたステップ情報を管理
- タイトル、操作、説明、ナレーション
- 音声URL

## 使用方法

### 1. プロジェクト作成
1. ダッシュボードから「新規プロジェクト」をクリック
2. タイトルと説明を入力
3. 動画ファイル（MP4/MOV）をアップロード

### 2. 動画処理
1. アップロード完了後、自動でフレーム抽出が開始されます
2. 処理が完了すると、「フレーム」タブに抽出された画像が表示されます

### 3. ステップ生成
1. 「ステップ」タブに移動
2. 「AIでステップを生成」ボタンをクリック
3. AIが各フレームを解析し、ステップ情報を自動生成します

### 4. 編集
1. 生成されたステップの「編集」ボタンをクリック
2. タイトル、操作、説明、ナレーションを修正できます
3. 不要なステップは「削除」ボタンで削除できます

### 5. エクスポート
- **スライド**: 「スライドをダウンロード」ボタンでPPTXファイルをダウンロード
- **動画**: 「動画をダウンロード」ボタンで音声付き解説動画（MP4）をダウンロード

## デプロイ

デプロイの詳細については、[DEPLOYMENT.md](./DEPLOYMENT.md) を参照してください。

### クイックスタート（ローカル開発）

```bash
# 依存関係をインストール
pnpm install

# 環境変数を設定
cp .env.example .env
# .env を編集（AUTH_MODE=none / VITE_AUTH_MODE=none）

# DBスキーマを反映
pnpm db:push

# 開発サーバー起動
pnpm dev
```

### 本番ビルド

```bash
pnpm run build
pnpm start
```

### ローカルMySQLセットアップ（Mac）

```bash
# MySQLをインストール
brew install mysql

# MySQLを起動
brew services start mysql

# データベースを作成
mysql -u root -e "CREATE DATABASE IF NOT EXISTS tutorialgen;"
```

Homebrewでインストールした場合、rootパスワードはデフォルトで未設定です。
`.env` に以下を設定してください：
```env
DATABASE_URL=mysql://root@localhost:3306/tutorialgen
```

### 環境変数

`.env.example` を `.env` にコピーして設定してください。詳細は [.env.example](./.env.example) を参照。

**本番環境で必須:**
```env
DATABASE_URL=mysql://user:password@host:3306/database
JWT_SECRET=your-very-long-secret-key-at-least-32-chars
AUTH_MODE=oauth
VITE_AUTH_MODE=oauth
OAUTH_SERVER_URL=https://oauth.example.com
VITE_OAUTH_PORTAL_URL=https://oauth-portal.example.com
VITE_APP_ID=your-app-id
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
TTS_PROVIDER=openai
```

本番環境では `AUTH_MODE=none` は禁止です。例外的に有効化する場合のみ `ALLOW_UNSAFE_AUTH_MODE_NONE=true` を明示してください（推奨しません）。

**ローカル開発（認証なし）例:**
```env
AUTH_MODE=none
VITE_AUTH_MODE=none
DEV_USER_OPEN_ID=local-dev-user
DEV_USER_NAME=Local Dev User
```

### LLM / TTS プロバイダー設定

```env
# LLM: openai | gemini | claude
LLM_PROVIDER=openai
LLM_MODEL=gpt-5.4
LLM_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=

# TTS: openai | gemini
TTS_PROVIDER=openai
TTS_MODEL=gpt-4o-mini-tts
TTS_API_KEY=
```

### ASR / OCR / キャッシュ設定

```env
ASR_PROVIDER=none            # none | openai | local_whisper
ASR_MODEL=whisper-1
ASR_LEAD_MS=3000             # 発話→操作の先行を考慮した参照ウィンドウ
OCR_PROVIDER=llm             # none | llm | engine（ローカルOCR、フォールバック付き）
PIPELINE_CACHE_DIR=./data/cache
FRAME_DEDUPE_HASH_DISTANCE=6

# 証拠抽出 / クリップ動画のパラメータは .env.example を参照
# (EVIDENCE_SAMPLE_FPS, EVIDENCE_DIFF_HIGH/LOW, CLIP_PAD_*, CLIP_MAX_DURATION_S)
```

- LLM/OCR/ASRの結果は `PIPELINE_CACHE_DIR` 配下にキャッシュされます。
- キャッシュキーは「入力ハッシュ + モデル名 + プロンプトバージョン + パラメータ」です。

### スライドプリセット設定

```env
# default | training
SLIDE_PRESET=default

# training プリセット向け ROI パラメータ
SLIDE_ROI_MIN_AREA_RATIO=0.015
SLIDE_ROI_MAX_AREA_RATIO=0.65
SLIDE_ROI_PADDING_RATIO=0.15
SLIDE_ROI_MIN_CROP_WIDTH_PX=900
SLIDE_SPOTLIGHT_OPACITY=0.35
```

- `training` は `16:9` のまま「画像:テキスト=65:35」に寄せ、右パネル可読性を優先します。
- 差分ROIが有効な場合は自動クロップし、ROI外を暗くする spotlight とハイライトを重ねます。
- クリック系ステップで差分ROIが不確実な場合は中央フォールバックのハイライトを適用します。

- APIキー解決順は `LLM_API_KEY` / `TTS_API_KEY` が最優先です。
- `LLM_API_KEY` 未設定時はプロバイダーごとのキー（OpenAI/Gemini/Anthropic）を参照します。
- `TTS_API_KEY` 未設定時は OpenAI/Gemini のキーを参照します。
- 開発環境でTTSが失敗した場合は無音フォールバックを生成します（本番はAPIキー未設定で起動エラー）。

## セキュリティ機能

- **認証**: OAuth 2.0 + JWT による認証
- **所有者チェック**: 全APIエンドポイントでリソースの所有者検証
- **レート制限**: Token Bucket アルゴリズムによるAPI制限
- **入力検証**: Zod スキーマによる厳密な入力検証
- **エラーサニタイズ**: センシティブ情報の除去

## 実装済み機能

- ✅ 動画アップロード（マルチパート、ディスクストリーミング、進捗表示付き）
- ✅ 操作セグメント抽出（ピクセル差分状態機械 + タイピング集約 + evidence.json）
- ✅ AIステップ一括執筆 + UIラベル機械検証（`LLM_PROVIDER`: OpenAI/Gemini/Claude）
- ✅ TTS音声合成（`TTS_PROVIDER`: OpenAI/Gemini）
- ✅ スライド生成（PowerPoint）
- ✅ クリップベース動画生成（元録画切り出し+音声モード選択）
- ✅ ダウンロード機能（スライド/動画）
- ✅ プロジェクト検索・フィルタリング
- ✅ 一括削除機能
- ✅ プロジェクト複製
- ✅ 削除取り消し（30秒以内）
- ✅ 処理の再試行（パラメータ調整可能）
- ✅ レート制限

## CLI（最小動作確認）

```bash
# セットアップ前提のプリフライト
pnpm setup:check

# v1通しスモーク（setup check → 生成 → PPTX/動画export → 編集同期）
pnpm v1:smoke -- --video ./sample.mp4 --outdir ./outputs/v1-smoke --use-audio false --asr-provider none --ocr-provider none

# v1リリース監査（未達条件を含めて確認）
pnpm v1:release-audit -- --allow-incomplete

# 一時チェックアウトでv1通しスモークを実行（依存インストールを伴う）
pnpm v1:fresh-env-smoke -- --video ./sample.mp4 --preflight-only
pnpm v1:fresh-env-smoke -- --video ./sample.mp4 --allow-install --install-mode offline

# フルパイプライン（DB + LLM APIキーが必要）
pnpm pipeline:generate --video ./sample.mp4 --outdir ./outputs --use-audio true --asr-provider openai --ocr-provider engine --preflight
pnpm pipeline:generate --video ./sample.mp4 --outdir ./outputs --use-audio true --asr-provider openai --ocr-provider engine

# 生成済みprojectからPPTX/動画を出力
pnpm project:export -- --project-id <id> --audio-mode silent --outdir ./outputs/project-export

# 生成済みprojectの編集→artifact同期を一時編集で確認（実行後に元へ復元）
pnpm edit:smoke -- --project-id <id> --outdir ./outputs/edit-smoke

# 証拠抽出のみ（DB・LLM不要）
pnpm evidence:extract -- --video ./sample.mp4 --outdir ./outputs/evidence

# 評価（合成データセット生成 → 測定）
pnpm eval:dataset
pnpm eval

# 評価ケースからPPTX/動画QA用の成果物を生成
pnpm eval:export-case -- --case real-app-workflow-04-export-video

# 人間G4レビュー用の作業シートを生成
pnpm g4:review-pack -- --case real-app-workflow-04-export-video --overwrite

# 出力QA済みの実録画ケースから、人間G4レビュー候補2件の作業シートを生成
pnpm g4:review-pack -- --release-candidates --overwrite

# 人間レビュー後のG4修正コスト記録（dry-runで確認してから書き込み）
pnpm g4:record -- --case <case-id> --reviewer <name> --reviewed-at YYYY-MM-DD --confirm-human-review --dry-run
```

- `pipeline:generate --preflight` の出力: 書き込みなしの実行計画（outdir作成、DB project、source video storage、steps生成は行わない）
- `pipeline:generate` の出力: `./outputs/project_<id>_steps.json`（`--dry-run` はno-writeではなく、outdir作成、プロジェクト作成、source video storage後に処理だけをスキップする）
- `v1:smoke` の出力: `./outputs/v1-smoke/v1_smoke_summary.json`（setup check、生成、export、編集同期の通しsummary）
- `v1:release-audit` の出力: v1リリース条件のPASS/FAIL/INCOMPLETE一覧。FAIL/INCOMPLETE checkには次に実行する `next:` を添える。`human_review` G4と新規環境スモーク証跡が無い場合は未達として扱う。
- `v1:fresh-env-smoke -- --preflight-only` の出力: fresh-env本実行前の前提確認（動画、clean worktree、`DATABASE_URL`、workdir）。依存インストールやsummary生成はしない。
- `v1:fresh-env-smoke` の出力: `./outputs/v1-fresh-env-smoke/v1_smoke_summary.json`（HEADから作った一時チェックアウト、依存インストール、v1通しスモークの証跡）
- `project:export` の出力: `./outputs/project-export/project_<id>_export_summary.json`（PPTX/MP4のstorage URL、ローカルpath、bytes、PPTX内画像/placeholderの `content_check`、`requested_audio_mode`、warnings、`still_image_fallback_count`）
- `edit:smoke` の出力: `./outputs/edit-smoke/project_<id>_edit_smoke_summary.json`（artifact-primary step adapter経由で一時編集し、adapter更新結果、DB stepのタイトル/説明/ナレーション、`steps.json` のタイトル/説明/ナレーション/`t_start`/`t_end`/音声モード/レビュー済み状態の同期を確認。実行後に元データへ復元）
- 追加オプション: `--cache-dir`, `--threshold`, `--min-interval`, `--max-frames`, `--debug`
- `eval:export-case` の出力: `eval/results/export-qa/<case-id>/`（PPTX、MP4、`qa-summary.json`。`eval/results/` はgitignore対象）
- `g4:review-pack` の出力: `outputs/g4-review-packets/<case-id>.md`（人間レビュー用の作業シート。`human_review` G4記録は書かない）
- `g4:review-pack -- --release-candidates` は、validな出力QAと成果物があり、まだ `human_review` G4が無い実録画ケースから既定2件を選ぶ。
- `g4:record` の出力: `eval/g4/records/<case-id>.json`（`human_review` G4記録。書き込みには `--confirm-human-review`、既存record置換には `--overwrite` が必要）
- 新規環境の詳細手順: [docs/setup-local.md](./docs/setup-local.md)
- v1最小リリースチェック: [docs/v1-release-checklist.md](./docs/v1-release-checklist.md)

## 今後の計画

生成品質（ステップ分割・グラウンディング・動画出力）の刷新計画が進行中です。詳細は以下を参照してください。

- [要件定義](./docs/requirements.md)
- [ロードマップ](./docs/roadmap.md)
- フェーズ別詳細プラン: [docs/plans/](./docs/plans/)

## ライセンス

MIT
