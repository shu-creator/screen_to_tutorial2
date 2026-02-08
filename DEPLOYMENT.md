# デプロイメントガイド

このドキュメントでは、TutorialGenをデプロイするために必要な要件と手順を説明します。

## システム要件

### 必須ソフトウェア

| ソフトウェア | バージョン | 用途 |
|-------------|-----------|------|
| Node.js | 18.x 以上 | サーバー実行環境 |
| Python | 3.8 以上 | フレーム抽出 (OpenCV) |
| FFmpeg | 4.x 以上 | 動画・音声処理 |
| MySQL/TiDB | 5.7 以上 | データベース |

### システム依存パッケージ

```bash
# Ubuntu/Debian の場合
apt-get update && apt-get install -y \
  python3 \
  python3-opencv \
  ffmpeg \
  libsm6 \
  libxext6

# macOS の場合
brew install python@3 ffmpeg opencv
```

## 環境変数

### 必須環境変数

```env
# データベース接続URL
DATABASE_URL=mysql://user:password@host:3306/database

# JWT認証用シークレット（32文字以上必須）
JWT_SECRET=your-very-long-secret-key-at-least-32-chars

# OAuth認証サーバーURL
OAUTH_SERVER_URL=https://oauth.example.com
```

### オプション環境変数

```env
# アプリケーションID
VITE_APP_ID=tutorial-gen

# LLM API設定（AI機能に必須）
BUILT_IN_FORGE_API_URL=https://api.openai.com
BUILT_IN_FORGE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx

# 管理者ユーザーのOpenID
OWNER_OPEN_ID=admin-user-open-id

# 本番環境フラグ
NODE_ENV=production
```

## データベースセットアップ

### 1. データベース作成

```sql
CREATE DATABASE tutorialgen CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 2. マイグレーション実行

```bash
# 依存関係をインストール
pnpm install

# マイグレーションを実行
pnpm drizzle-kit push
```

**注意**: `postbuild` スクリプトにマイグレーションが含まれているため、`pnpm run build` 後に自動実行されます。

## ビルドとデプロイ

### 1. 依存関係のインストール

```bash
pnpm install
```

### 2. ビルド

```bash
pnpm run build
```

このコマンドは以下を実行します：
1. フロントエンドのビルド (Vite)
2. バックエンドのビルド (esbuild)
3. データベースマイグレーション (Drizzle)

### 3. サーバー起動

```bash
pnpm start
```

## セキュリティ設定

### JWT_SECRET の生成

```bash
# 安全なシークレットを生成
openssl rand -base64 48
```

**重要**: JWT_SECRET は32文字以上必須です。短いシークレットを使用すると、本番環境でエラーが発生します。

### レート制限

APIにはレート制限が組み込まれています：

| エンドポイント | 制限 |
|--------------|------|
| project.create | 5回/分 |
| project.processVideo | 3回/分 |
| step.generate | 5回/分 |
| video.generateAudio | 3回/分 |
| video.generate | 3回/分 |
| project.list | 120回/分 |
| project.getProgress | 300回/分 |

## S3/ストレージ設定

Manusプラットフォームでは、組み込みのストレージプロキシが使用されます。
カスタムデプロイの場合は、`server/storage.ts` を適切なS3/GCS/Azure Blobクライアントに置き換えてください。

## TTS（音声合成）設定

TTS機能はOpenAI TTS API互換のエンドポイントを使用します。

### 対応音声

| Voice ID | 説明 |
|----------|------|
| alloy | 中性的で落ち着いた声 |
| echo | 男性的で深みのある声 |
| fable | イギリス英語風の声 |
| onyx | 男性的で力強い声 |
| nova | 女性的で明るい声（推奨） |
| shimmer | 女性的で柔らかい声 |

### 設定

```env
BUILT_IN_FORGE_API_URL=https://api.openai.com
BUILT_IN_FORGE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

**注意**: TTS APIキーが設定されていない場合、無音のフォールバック音声が生成されます。

## トラブルシューティング

### よくあるエラー

#### 1. "JWT_SECRET は32文字以上が必須です"

```
解決策: JWT_SECRET を32文字以上に設定してください
```

#### 2. "DATABASE_URL is not set"

```
解決策: DATABASE_URL 環境変数を設定してください
```

#### 3. "OpenCV not found" / フレーム抽出が失敗する

```bash
# Python OpenCVをインストール
pip3 install opencv-python-headless
# または
apt-get install python3-opencv
```

#### 4. "FFmpeg not found"

```bash
apt-get install ffmpeg
# または
brew install ffmpeg
```

#### 5. "drizzle-kit: command not found"

```bash
pnpm install
```

### ログの確認

開発環境ではコンソールに色付きログが出力されます。
本番環境ではJSON形式のログが出力されます。

```bash
# 本番環境のログ形式
{"timestamp":"2024-01-15T10:30:00.000Z","level":"info","context":"Router","message":"Request processed"}
```

## ヘルスチェック

アプリケーションが正常に動作しているか確認するには：

```bash
curl http://localhost:3000/api/health
```

## 推奨ハードウェア

| コンポーネント | 最小要件 | 推奨 |
|--------------|---------|------|
| CPU | 2コア | 4コア以上 |
| メモリ | 2GB | 4GB以上 |
| ディスク | 10GB | 50GB以上（動画処理のため） |

## Docker デプロイ（参考）

```dockerfile
FROM node:18-slim

# システム依存パッケージをインストール
RUN apt-get update && apt-get install -y \
  python3 \
  python3-opencv \
  ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

EXPOSE 3000
CMD ["pnpm", "start"]
```

## サポート

問題が発生した場合は、GitHub Issuesでお知らせください。
