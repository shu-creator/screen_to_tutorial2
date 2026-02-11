import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { promisify } from "util";
import { getDb } from "../db";
import { ENV } from "./env";

const execFileAsync = promisify(execFile);
const HEALTH_CACHE_TTL_MS = 5_000;

type HealthStatus = "ok" | "warn" | "error";

export interface HealthCheckResult {
  ok: boolean;
  status: HealthStatus;
  message: string;
}

export interface HealthResponse {
  ok: boolean;
  timestamp: string;
  checks: {
    db: HealthCheckResult;
    storage: HealthCheckResult;
    llm: HealthCheckResult;
    tts: HealthCheckResult;
    ffmpeg: HealthCheckResult;
  };
}

let cachedHealth:
  | {
      expiresAt: number;
      value: HealthResponse;
    }
  | null = null;
let pendingHealthCheck: Promise<HealthResponse> | null = null;

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Unknown error";
}

function checkApiKey(
  configured: boolean,
  missingMessage: string,
): HealthCheckResult {
  if (configured) {
    return { ok: true, status: "ok", message: "Configured" };
  }
  return { ok: false, status: "warn", message: missingMessage };
}

async function checkDatabase(): Promise<HealthCheckResult> {
  if (!ENV.databaseUrl) {
    return {
      ok: false,
      status: "error",
      message: "DATABASE_URL is not configured",
    };
  }

  try {
    const db = await getDb();
    if (!db) {
      return {
        ok: false,
        status: "error",
        message: "Database connection is unavailable",
      };
    }
    await db.execute(sql`SELECT 1`);
    return { ok: true, status: "ok", message: "Database reachable" };
  } catch (error) {
    return {
      ok: false,
      status: "error",
      message: `Database check failed: ${messageFromError(error)}`,
    };
  }
}

async function checkStorage(): Promise<HealthCheckResult> {
  const tempFilename = `.health-${Date.now()}-${nanoid(8)}.tmp`;
  const tempPath = path.join(ENV.storageDir, tempFilename);

  try {
    await fs.writeFile(tempPath, "ok");
    await fs.rm(tempPath, { force: true });
    return { ok: true, status: "ok", message: "Storage writable" };
  } catch (error) {
    return {
      ok: false,
      status: "error",
      message: `Storage check failed: ${messageFromError(error)}`,
    };
  }
}

async function checkFfmpeg(): Promise<HealthCheckResult> {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5_000 });
    return { ok: true, status: "ok", message: "ffmpeg available" };
  } catch {
    return {
      ok: false,
      status: "warn",
      message: "ffmpeg is not available on PATH",
    };
  }
}

async function runHealthChecks(): Promise<HealthResponse> {
  const [db, storage, ffmpeg] = await Promise.all([
    checkDatabase(),
    checkStorage(),
    checkFfmpeg(),
  ]);

  const llm = checkApiKey(
    Boolean(ENV.llmApiKey),
    "LLM API key is not configured",
  );
  const tts = checkApiKey(
    Boolean(ENV.ttsApiKey),
    "TTS API key is not configured",
  );

  return {
    ok: db.ok && storage.ok,
    timestamp: new Date().toISOString(),
    checks: {
      db,
      storage,
      llm,
      tts,
      ffmpeg,
    },
  };
}

export async function getHealth(): Promise<HealthResponse> {
  const now = Date.now();
  if (cachedHealth && cachedHealth.expiresAt > now) {
    return cachedHealth.value;
  }

  if (!pendingHealthCheck) {
    pendingHealthCheck = runHealthChecks()
      .then((result) => {
        cachedHealth = {
          value: result,
          expiresAt: Date.now() + HEALTH_CACHE_TTL_MS,
        };
        return result;
      })
      .finally(() => {
        pendingHealthCheck = null;
      });
  }

  return pendingHealthCheck;
}
