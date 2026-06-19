import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

type Check = {
  name: string;
  ok: boolean;
  detail: string;
};

async function commandVersion(command: string, args: string[] = ["--version"]): Promise<Check> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 10_000 });
    const firstLine = `${stdout || stderr}`.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "ok";
    return { name: command, ok: true, detail: firstLine };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: command, ok: false, detail: message };
  }
}

async function checkNodeVersion(): Promise<Check> {
  try {
    const { stdout } = await execFileAsync("node", ["--version"], { timeout: 10_000 });
    const raw = stdout.trim();
    const major = Number.parseInt(raw.replace(/^v/, "").split(".")[0] ?? "0", 10);
    const ok = Number.isFinite(major) && major >= 22;
    return {
      name: "node",
      ok,
      detail: ok ? raw : `${raw || "unknown"} - Node.js 22+ required`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "node", ok: false, detail: message };
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function checkPackageScripts(): Promise<Check> {
  const packageJson = await readJson<{ scripts?: Record<string, string> }>(path.join(repoRoot, "package.json"));
  const requiredScripts = [
    "check",
    "test",
    "build",
    "db:push",
    "pipeline:generate",
    "project:export",
    "evidence:extract",
    "eval",
    "eval:audit",
    "eval:quality-gate",
    "eval:export-case",
    "setup:check",
  ];
  const missing = requiredScripts.filter((script) => !packageJson.scripts?.[script]);
  return {
    name: "package scripts",
    ok: missing.length === 0,
    detail: missing.length === 0 ? `found ${requiredScripts.length} required scripts` : `missing: ${missing.join(", ")}`,
  };
}

async function checkEnvExample(): Promise<Check> {
  const envExample = await fs.readFile(path.join(repoRoot, ".env.example"), "utf8");
  const envLines = new Set(
    envExample
      .split("\n")
      .map((line) => line.trim())
      .map((line) => line.replace(/\s+#.*$/, "").trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
  const requiredLines = [
    "AUTH_MODE=none",
    "VITE_AUTH_MODE=none",
    "LLM_PROVIDER=openai",
    "LLM_MODEL=gpt-5.4",
    "ASR_PROVIDER=none",
    "OCR_PROVIDER=llm",
    "STORAGE_DIR=./data/storage",
  ];
  const missing = requiredLines.filter((line) => !envLines.has(line));
  return {
    name: ".env.example",
    ok: missing.length === 0,
    detail: missing.length === 0 ? "local defaults and gpt-5.4 are present" : `missing: ${missing.join(", ")}`,
  };
}

async function checkEvalDocs(): Promise<Check> {
  const files = [
    "eval/README.md",
    "docs/v1-release-checklist.md",
    "docs/setup-local.md",
  ];
  const missing: string[] = [];
  for (const file of files) {
    try {
      await fs.access(path.join(repoRoot, file));
    } catch {
      missing.push(file);
    }
  }
  return {
    name: "setup docs",
    ok: missing.length === 0,
    detail: missing.length === 0 ? files.join(", ") : `missing: ${missing.join(", ")}`,
  };
}

async function main(): Promise<void> {
  const checks: Check[] = [
    await checkNodeVersion(),
    await commandVersion("pnpm"),
    await commandVersion("ffmpeg", ["-version"]),
    await commandVersion("ffprobe", ["-version"]),
    await checkPackageScripts(),
    await checkEnvExample(),
    await checkEvalDocs(),
  ];

  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new Error(`setup check failed: ${failed.map((check) => check.name).join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
