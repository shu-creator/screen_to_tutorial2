# Local Setup And Generation

この手順は、新規環境で「セットアップから生成まで通る」ことを確認するための最小手順である。

## 前提

- Node.js 22以上とpnpmが使えること
- MySQL互換DBが使えること
- ffmpeg / ffprobe が使えること
- フル生成にはLLM APIキーが必要

macOSで不足している場合:

```bash
brew install mysql ffmpeg
brew services start mysql
mysql -u root -e "CREATE DATABASE IF NOT EXISTS tutorialgen;"
```

## 1. 依存関係とプリフライト

```bash
pnpm install
pnpm setup:check
```

`pnpm setup:check` は Node.js、pnpm、ffmpeg、ffprobe、主要npm scripts、`.env.example` の既定値、セットアップdocsの存在を確認する。DB接続やAPIキーの有効性は確認しない。

## 2. 環境変数

```bash
cp .env.example .env
```

ローカル認証なしで動かす最小例:

```env
DATABASE_URL=mysql://root@localhost:3306/tutorialgen
AUTH_MODE=none
VITE_AUTH_MODE=none
DEV_USER_OPEN_ID=local-dev-user
DEV_USER_NAME=Local Dev User
LLM_PROVIDER=openai
LLM_MODEL=gpt-5.4
OPENAI_API_KEY=sk-...
ASR_PROVIDER=none
OCR_PROVIDER=llm
STORAGE_DIR=./data/storage
```

音声付き出力を確認する場合はTTSキーも設定する:

```env
TTS_PROVIDER=openai
TTS_MODEL=gpt-4o-mini-tts
TTS_API_KEY=sk-...
```

## 3. DB初期化

```bash
pnpm db:push
```

## 4. 生成スモーク

任意の画面録画 `sample.mp4` を用意して実行する:

```bash
pnpm pipeline:generate --video ./sample.mp4 --outdir ./outputs --use-audio false --asr-provider none --ocr-provider llm
```

完了条件:

- `outputs/project_<id>_steps.json` が生成される
- 生成されたJSONに `version: "2.0"` と `steps` 配列がある
- 実行中にLLM API 429/520やfallback-heavy runが出た場合は成功扱いにしない

生成されたproject idからPPTX/動画出力も確認する:

```bash
pnpm project:export -- --project-id <id> --audio-mode silent --outdir ./outputs/project-export
```

完了条件:

- `outputs/project-export/project_<id>_export_summary.json` が生成される
- ローカルストレージではsummary内の `slide.bytes` と `video.bytes` が `null` でなく0より大きい。リモートストレージURLの場合は `bytes` が `null` になるため、URL先のファイルサイズをストレージ側で確認する
- `slide.content_check.status` が `pass` で、`slides_with_images` と `media_image_count` が `expected_step_image_count` 以上、`placeholder_text_hits` が空である。`total_slide_count` は表紙、目次、ステップ、完了スライドを含む総数である
- 最終出荷前はPPTXを開き、各ステップ画像がプレースホルダーではなく実画面になっていることを目視確認する
- `video.still_image_fallback_count` と `video.warnings` を確認し、出荷判定時はG4に反映する

ASRとTTSも含めて確認する場合:

```bash
pnpm pipeline:generate --video ./sample.mp4 --outdir ./outputs --use-audio true --asr-provider openai --ocr-provider engine
```

## 5. 評価と出力QA

ローカルに評価用 `video.mp4` と `eval/results/generated/<case-id>/steps.json` がある場合:

```bash
pnpm eval
pnpm eval:audit
pnpm eval:quality-gate
pnpm eval:export-case -- --case real-app-workflow-04-export-video --case real-app-workflow-05-narrated-create-project
```

`eval/results/` と評価動画はgitignore対象である。新規環境では `eval/dataset/<case-id>/meta.json` の `regenerate_command`、または `pnpm pipeline:generate` の出力配置で復元してから実行する。評価ケース構成は [eval/README.md](../eval/README.md) を参照。

## 6. 開発サーバー

```bash
pnpm dev
```

ブラウザからプロジェクト作成、ステップ生成、編集、PPTX/動画生成まで確認する。
