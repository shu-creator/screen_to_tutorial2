/**
 * 構造化ロギングシステム
 * - JSON形式でログを出力（本番環境）
 * - 開発環境では読みやすい形式で出力
 * - ログレベル: debug, info, warn, error
 * - コンテキスト情報の付与
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  [key: string]: unknown;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// 環境変数からログレベルを取得（デフォルト: info）
const currentLogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";
const isProduction = process.env.NODE_ENV === "production";

// センシティブ情報を除去
function sanitizeContext(context: LogContext): LogContext {
  const sensitiveKeys = ["password", "secret", "token", "apiKey", "authorization", "cookie"];
  const sanitized: LogContext = {};

  for (const [key, value] of Object.entries(context)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "string" && value.length > 500) {
      // 長すぎる値は切り詰め
      sanitized[key] = value.substring(0, 500) + "...[truncated]";
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

// ファイルパスを除去
function sanitizeMessage(message: string): string {
  // 絶対パスをマスク
  return message.replace(/\/[\w./-]+/g, (match) => {
    // /tmp や /var などの一般的なパスはそのまま
    if (match.startsWith("/tmp") || match.startsWith("/var")) {
      return match;
    }
    // それ以外はマスク
    const parts = match.split("/");
    const filename = parts[parts.length - 1];
    return `[path]/${filename}`;
  });
}

function formatLogEntry(entry: LogEntry): string {
  if (isProduction) {
    // 本番環境: JSON形式
    return JSON.stringify(entry);
  }

  // 開発環境: 読みやすい形式
  const levelColors: Record<LogLevel, string> = {
    debug: "\x1b[36m", // cyan
    info: "\x1b[32m",  // green
    warn: "\x1b[33m",  // yellow
    error: "\x1b[31m", // red
  };
  const reset = "\x1b[0m";
  const color = levelColors[entry.level];
  const levelStr = entry.level.toUpperCase().padEnd(5);

  let output = `${entry.timestamp} ${color}${levelStr}${reset} [${entry.module}] ${entry.message}`;

  if (entry.context && Object.keys(entry.context).length > 0) {
    output += ` ${JSON.stringify(entry.context)}`;
  }

  if (entry.error) {
    output += `\n  Error: ${entry.error.message}`;
    if (entry.error.stack && !isProduction) {
      output += `\n  ${entry.error.stack}`;
    }
  }

  return output;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel];
}

function createLogEntry(
  level: LogLevel,
  module: string,
  message: string,
  context?: LogContext,
  error?: Error
): LogEntry {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message: sanitizeMessage(message),
  };

  if (context) {
    entry.context = sanitizeContext(context);
  }

  if (error) {
    entry.error = {
      name: error.name,
      message: sanitizeMessage(error.message),
      stack: isProduction ? undefined : error.stack,
    };
  }

  return entry;
}

function log(level: LogLevel, module: string, message: string, context?: LogContext, error?: Error): void {
  if (!shouldLog(level)) return;

  const entry = createLogEntry(level, module, message, context, error);
  const formatted = formatLogEntry(entry);

  switch (level) {
    case "debug":
    case "info":
      console.log(formatted);
      break;
    case "warn":
      console.warn(formatted);
      break;
    case "error":
      console.error(formatted);
      break;
  }
}

/**
 * モジュール固有のロガーを作成
 * @param module モジュール名（例: "VideoProcessor", "Database"）
 */
export function createLogger(module: string) {
  return {
    debug: (message: string, context?: LogContext) => log("debug", module, message, context),
    info: (message: string, context?: LogContext) => log("info", module, message, context),
    warn: (message: string, context?: LogContext, error?: Error) => log("warn", module, message, context, error),
    error: (message: string, context?: LogContext, error?: Error) => log("error", module, message, context, error),
  };
}

// デフォルトロガー
export const logger = createLogger("App");
