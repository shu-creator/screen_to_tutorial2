import crypto from "crypto";
import path from "path";

type AuthMode = "none" | "oauth";
type LLMProvider = "openai" | "gemini" | "claude";
type TTSProvider = "openai" | "gemini";
type SlidePreset = "default" | "training";

const DEFAULT_LLM_MODEL: Record<LLMProvider, string> = {
  openai: "gpt-5.2",
  gemini: "gemini-3-flash-preview",
  claude: "claude-sonnet-4-5",
};

const DEFAULT_TTS_MODEL: Record<TTSProvider, string> = {
  openai: "gpt-4o-mini-tts",
  gemini: "gemini-2.5-flash-preview-tts",
};

const DEV_DEFAULT_JWT_SECRET =
  "dev-only-jwt-secret-do-not-use-in-production-change-this";

function requireEnv(key: string, defaultValue?: string): string {
  const rawValue = process.env[key];
  const value = rawValue && rawValue.length > 0 ? rawValue : defaultValue;
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`必須環境変数 ${key} が設定されていません`);
  }
  return value ?? "";
}

function parseEnumEnv<T extends string>(
  key: string,
  allowed: readonly T[],
  defaultValue: T
): T {
  const value = process.env[key];
  if (!value) return defaultValue;
  if (allowed.includes(value as T)) {
    return value as T;
  }
  throw new Error(
    `環境変数 ${key} の値が不正です: ${value}. 許可値: ${allowed.join(", ")}`
  );
}

function parseNumberEnv(
  key: string,
  defaultValue: number,
  options?: { min?: number; max?: number }
): number {
  const value = process.env[key];
  if (!value) return defaultValue;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`環境変数 ${key} の値が数値ではありません: ${value}`);
  }

  if (options?.min !== undefined && parsed < options.min) {
    throw new Error(`環境変数 ${key} は ${options.min} 以上である必要があります`);
  }
  if (options?.max !== undefined && parsed > options.max) {
    throw new Error(`環境変数 ${key} は ${options.max} 以下である必要があります`);
  }

  return parsed;
}

function resolveLLMApiKey(provider: LLMProvider): string {
  if (process.env.LLM_API_KEY) {
    return process.env.LLM_API_KEY;
  }

  if (provider === "openai") {
    return process.env.OPENAI_API_KEY ?? "";
  }
  if (provider === "gemini") {
    return process.env.GEMINI_API_KEY ?? "";
  }
  return process.env.ANTHROPIC_API_KEY ?? "";
}

function resolveTTSApiKey(provider: TTSProvider): string {
  if (process.env.TTS_API_KEY) {
    return process.env.TTS_API_KEY;
  }

  if (provider === "openai") {
    return process.env.OPENAI_API_KEY ?? "";
  }

  return process.env.GEMINI_API_KEY ?? "";
}

const authMode = parseEnumEnv<AuthMode>(
  "AUTH_MODE",
  ["none", "oauth"],
  "oauth"
);
const llmProvider = parseEnumEnv<LLMProvider>(
  "LLM_PROVIDER",
  ["openai", "gemini", "claude"],
  "openai"
);
const ttsProvider = parseEnumEnv<TTSProvider>(
  "TTS_PROVIDER",
  ["openai", "gemini"],
  "openai"
);
const slidePreset = parseEnumEnv<SlidePreset>(
  "SLIDE_PRESET",
  ["default", "training"],
  "default"
);

const llmModel = process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL[llmProvider];
const ttsModel = process.env.TTS_MODEL ?? DEFAULT_TTS_MODEL[ttsProvider];
const llmApiKey = resolveLLMApiKey(llmProvider);
const ttsApiKey = resolveTTSApiKey(ttsProvider);
const slideRoiMinAreaRatio = parseNumberEnv(
  "SLIDE_ROI_MIN_AREA_RATIO",
  0.015,
  { min: 0, max: 1 }
);
const slideRoiMaxAreaRatio = parseNumberEnv(
  "SLIDE_ROI_MAX_AREA_RATIO",
  0.65,
  { min: 0, max: 1 }
);
const slideRoiPaddingRatio = parseNumberEnv(
  "SLIDE_ROI_PADDING_RATIO",
  0.15,
  { min: 0, max: 0.5 }
);
const slideRoiMinCropWidthPx = parseNumberEnv(
  "SLIDE_ROI_MIN_CROP_WIDTH_PX",
  900,
  { min: 100 }
);
const slideSpotlightOpacity = parseNumberEnv(
  "SLIDE_SPOTLIGHT_OPACITY",
  0.35,
  { min: 0, max: 1 }
);

function validateEnvOnStartup(): void {
  const isProduction = process.env.NODE_ENV === "production";
  const allowUnsafeNoneAuthInProduction =
    process.env.ALLOW_UNSAFE_AUTH_MODE_NONE === "true";

  if (slideRoiMinAreaRatio > slideRoiMaxAreaRatio) {
    throw new Error(
      "SLIDE_ROI_MIN_AREA_RATIO は SLIDE_ROI_MAX_AREA_RATIO 以下である必要があります"
    );
  }

  if (isProduction) {
    if (authMode === "none" && !allowUnsafeNoneAuthInProduction) {
      throw new Error(
        "本番環境では AUTH_MODE=none は禁止です。必要な場合のみ ALLOW_UNSAFE_AUTH_MODE_NONE=true を明示してください"
      );
    }

    const requiredVars = ["JWT_SECRET", "DATABASE_URL"];
    if (authMode === "oauth") {
      requiredVars.push("OAUTH_SERVER_URL", "VITE_APP_ID", "VITE_OAUTH_PORTAL_URL");
    }

    const missing = requiredVars.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(
        `本番環境では以下の環境変数が必須です: ${missing.join(", ")}`
      );
    }

    if (!llmApiKey) {
      throw new Error("本番環境では LLM 用の API キーが必須です");
    }
    if (!ttsApiKey) {
      throw new Error("本番環境では TTS 用の API キーが必須です");
    }

    if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
      throw new Error("JWT_SECRET は32文字以上が必須です（セキュリティ要件）");
    }
  }
}

validateEnvOnStartup();

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  authMode,
  cookieSecret: requireEnv(
    "JWT_SECRET",
    process.env.NODE_ENV === "production"
      ? undefined
      : `${DEV_DEFAULT_JWT_SECRET}-${crypto.randomUUID()}`
  ),
  databaseUrl: requireEnv("DATABASE_URL"),
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  storageDir:
    process.env.STORAGE_DIR ?? path.resolve(process.cwd(), "data", "storage"),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  llmProvider,
  llmModel,
  llmApiKey,
  ttsProvider,
  ttsModel,
  ttsApiKey,
  slidePreset,
  slideRoiMinAreaRatio,
  slideRoiMaxAreaRatio,
  slideRoiPaddingRatio,
  slideRoiMinCropWidthPx,
  slideSpotlightOpacity,
  oauthPortalUrl: process.env.VITE_OAUTH_PORTAL_URL ?? "",
};

export type { AuthMode, LLMProvider, TTSProvider, SlidePreset };
