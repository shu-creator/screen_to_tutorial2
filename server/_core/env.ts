// 必須環境変数の検証関数
function requireEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`必須環境変数 ${key} が設定されていません`);
  }
  return value ?? "";
}

// 起動時の環境変数検証
function validateEnvOnStartup(): void {
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    const requiredVars = ["JWT_SECRET", "DATABASE_URL", "OAUTH_SERVER_URL"];
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
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: requireEnv("JWT_SECRET"),
  databaseUrl: requireEnv("DATABASE_URL"),
  oAuthServerUrl: requireEnv("OAUTH_SERVER_URL"),
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
};
