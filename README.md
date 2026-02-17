# TutorialGen - 画面録画から説明動画を自動生成

操作動画をアップロードするだけで、AIが自動で手順を解析し、スライドと音声付きの解説動画を数分で作成できるWebアプリケーションです。

## 主な機能

### 1. 動画アップロードとフレーム抽出
- MP4/MOV形式の画面録画をアップロード
- OpenCVによるフレーム間差分検知
- 重要な操作手順を自動でキーフレームとして抽出

### 2. AI画像解析とステップ構造化
- LLM（`LLM_PROVIDER` で選択）による画像解析
- 各フレームから以下の情報を自動生成：
  - ステップタイトル
  - 操作説明
  - 詳細な説明
  - 音声ナレーション原稿

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
- テキスト読み上げ（TTS）による音声生成
- FFmpegによる静止画と音声の合成
- 最終的な解説動画（MP4）の出力

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
- OpenCV（Python）
- FFmpeg
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
│   ├── videoProcessor.ts  # 動画処理エンジン
│   ├── stepGenerator.ts   # AIステップ生成
│   ├── slideGenerator.ts  # スライド生成
│   └── videoGenerator.ts  # 動画・音声生成
├── drizzle/               # データベーススキーマ
│   └── schema.ts
├── scripts/               # Pythonスクリプト
│   └── extract_frames.py  # フレーム抽出スクリプト
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
LLM_MODEL=gpt-5.2
LLM_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=

# TTS: openai | gemini
TTS_PROVIDER=openai
TTS_MODEL=gpt-4o-mini-tts
TTS_API_KEY=
```

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

- ✅ 動画アップロード（Base64エンコード、進捗表示付き）
- ✅ フレーム抽出（OpenCV）
- ✅ AIステップ生成（`LLM_PROVIDER`: OpenAI/Gemini/Claude）
- ✅ TTS音声合成（`TTS_PROVIDER`: OpenAI/Gemini）
- ✅ スライド生成（PowerPoint）
- ✅ 動画生成（FFmpeg）
- ✅ ダウンロード機能（スライド/動画）
- ✅ プロジェクト検索・フィルタリング
- ✅ 一括削除機能
- ✅ プロジェクト複製
- ✅ 削除取り消し（30秒以内）
- ✅ 処理の再試行（パラメータ調整可能）
- ✅ レート制限

## 今後の改善点

1. **マルチパートアップロード対応**
   - 大容量ファイルの効率的なアップロード
   - アップロード再開機能

2. **ステップの並べ替え機能**
   - ドラッグ&ドロップによる並べ替え
   - sortOrderの自動更新

3. **画像の差し替え機能**
   - 手動で画像をアップロードして差し替え
   - フレームの再抽出

4. **エクスポート設定**
   - スライドテンプレートの選択
   - 動画解像度・フォーマットの設定

5. **バッチ処理**
   - 複数の動画を一括処理
   - プロジェクトのテンプレート化

## ライセンス

MIT
