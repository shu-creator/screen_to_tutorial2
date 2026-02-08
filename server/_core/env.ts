// 必須環境変数の検証関数
function requireEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`必須環境変数 ${key} が設定されていません`);
  }
  return value ?? "";
}

// AUTH_MODEを先に解決（バリデーションで使うため）
// デフォルトは常に "oauth"（secure by default）。"none" は明示設定のみ許可
const VALID_AUTH_MODES = ["none", "oauth"] as const;
type AuthMode = (typeof VALID_AUTH_MODES)[number];
const rawAuthMode = process.env.AUTH_MODE ?? "oauth";
if (!VALID_AUTH_MODES.includes(rawAuthMode as AuthMode)) {
  throw new Error(
    `AUTH_MODE="${rawAuthMode}" は無効です。有効な値: ${VALID_AUTH_MODES.join(", ")}`
  );
}
if (rawAuthMode === "none" && process.env.NODE_ENV === "production") {
  throw new Error(
    "AUTH_MODE=none は本番環境では使用できません。" +
    "AUTH_MODE=oauth を設定するか、AUTH_MODE を未設定にしてください（デフォルト: oauth）"
  );
}
const authMode: AuthMode = rawAuthMode as AuthMode;

// 起動時の環境変数検証
function validateEnvOnStartup(): void {
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    const requiredVars = ["JWT_SECRET", "DATABASE_URL"];
    // OAuthモードの場合のみOAUTH_SERVER_URLを必須にする
    if (authMode === "oauth") {
      requiredVars.push("OAUTH_SERVER_URL");
    }
    const missing = requiredVars.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      throw new Error(
        `本番環境では以下の環境変数が必須です: ${missing.join(", ")}`
      );
    }

    // JWT_SECRETの強度チェック（32文字未満は拒否）
    if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
      throw new Error(
        "JWT_SECRET は32文字以上が必須です（セキュリティ要件）"
      );
    }
  }
}

// 起動時に検証を実行
validateEnvOnStartup();

export const ENV = {
  // --- アプリ基本設定 ---
  appId: process.env.VITE_APP_ID ?? "tutorialgen",
  isProduction: process.env.NODE_ENV === "production",

  // --- 認証 ---
  authMode,
  cookieSecret: requireEnv("JWT_SECRET", "dev-secret-change-in-production-32chars!"),
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "local-admin",

  // --- データベース ---
  databaseUrl: requireEnv("DATABASE_URL", "mysql://root:password@localhost:3306/tutorialgen"),

  // --- ストレージ ---
  storagePath: process.env.STORAGE_PATH ?? "./data/storage",

  // --- LLM/TTS（現在はManus Forge経由、Phase 6-7で移行予定） ---
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",

  // --- LLM プロバイダー切り替え（Phase 6で実装予定） ---
  llmProvider: process.env.LLM_PROVIDER ?? "openai",
  llmApiKey: process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
  llmApiUrl: process.env.LLM_API_URL ?? "",
  llmModel: process.env.LLM_MODEL ?? "",

  // --- TTS プロバイダー切り替え（Phase 7で実装予定） ---
  ttsProvider: process.env.TTS_PROVIDER ?? "openai",
  ttsApiKey: process.env.TTS_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
  ttsApiUrl: process.env.TTS_API_URL ?? "",
  ttsModel: process.env.TTS_MODEL ?? "",
  ttsVoice: process.env.TTS_VOICE ?? "nova",
};
