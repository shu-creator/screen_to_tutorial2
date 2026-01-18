/**
 * Temporary file management utilities
 * Provides safe cleanup with logging and retry logic
 */

import fs from "fs/promises";
import path from "path";
import { createLogger } from "./_core/logger";

const logger = createLogger("TempFileManager");

// Track temp files for cleanup on process exit
const tempFiles = new Set<string>();
const tempDirs = new Set<string>();

/**
 * Register a temp file for tracking
 * Will be cleaned up on process exit if not manually removed
 */
export function registerTempFile(filePath: string): void {
  tempFiles.add(filePath);
}

/**
 * Register a temp directory for tracking
 */
export function registerTempDir(dirPath: string): void {
  tempDirs.add(dirPath);
}

/**
 * Safely delete a temp file with retry logic
 * @param filePath Path to the file
 * @param context Context for logging (e.g., "SlideGenerator")
 * @param maxRetries Maximum retry attempts (default: 3)
 */
export async function safeTempFileDelete(
  filePath: string,
  context: string,
  maxRetries: number = 3
): Promise<boolean> {
  const retryDelay = 500; // 500ms between retries

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fs.unlink(filePath);
      tempFiles.delete(filePath);
      return true;
    } catch (error) {
      const isNotFound = (error as NodeJS.ErrnoException).code === "ENOENT";

      if (isNotFound) {
        // File doesn't exist, that's fine
        tempFiles.delete(filePath);
        return true;
      }

      if (attempt < maxRetries) {
        logger.warn(`[${context}] Temp file cleanup attempt ${attempt} failed, retrying: ${filePath}`);
        await sleep(retryDelay);
      } else {
        logger.error(
          `[${context}] Failed to cleanup temp file after ${maxRetries} attempts: ${filePath}`,
          undefined,
          error as Error
        );
        return false;
      }
    }
  }

  return false;
}

/**
 * Safely delete a temp directory with retry logic
 * @param dirPath Path to the directory
 * @param context Context for logging
 * @param maxRetries Maximum retry attempts (default: 3)
 */
export async function safeTempDirDelete(
  dirPath: string,
  context: string,
  maxRetries: number = 3
): Promise<boolean> {
  const retryDelay = 1000; // 1 second between retries

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      tempDirs.delete(dirPath);
      return true;
    } catch (error) {
      const isNotFound = (error as NodeJS.ErrnoException).code === "ENOENT";

      if (isNotFound) {
        tempDirs.delete(dirPath);
        return true;
      }

      if (attempt < maxRetries) {
        logger.warn(`[${context}] Temp dir cleanup attempt ${attempt} failed, retrying: ${dirPath}`);
        await sleep(retryDelay);
      } else {
        logger.error(
          `[${context}] Failed to cleanup temp dir after ${maxRetries} attempts: ${dirPath}`,
          undefined,
          error as Error
        );
        logger.warn(`[${context}] Manual cleanup may be required: rm -rf ${dirPath}`);
        return false;
      }
    }
  }

  return false;
}

/**
 * Create a unique temp file path
 * @param prefix Prefix for the filename
 * @param extension File extension (e.g., ".jpg", ".mp3")
 */
export function createTempFilePath(prefix: string, extension: string): string {
  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${extension}`;
  const filePath = path.join("/tmp", filename);
  registerTempFile(filePath);
  return filePath;
}

/**
 * Create a unique temp directory
 * @param prefix Prefix for the directory name
 */
export async function createTempDir(prefix: string): Promise<string> {
  const dirname = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dirPath = path.join("/tmp", dirname);
  await fs.mkdir(dirPath, { recursive: true });
  registerTempDir(dirPath);
  return dirPath;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Cleanup all tracked temp files and directories
 * Called on process exit
 */
async function cleanupOnExit(): Promise<void> {
  const context = "ProcessExit";

  if (tempFiles.size > 0) {
    logger.info(`Cleaning up ${tempFiles.size} temp files on exit`);
    const files = Array.from(tempFiles);
    for (const filePath of files) {
      await safeTempFileDelete(filePath, context, 1);
    }
  }

  if (tempDirs.size > 0) {
    logger.info(`Cleaning up ${tempDirs.size} temp directories on exit`);
    const dirs = Array.from(tempDirs);
    for (const dirPath of dirs) {
      await safeTempDirDelete(dirPath, context, 1);
    }
  }
}

// Register cleanup handlers
process.on("beforeExit", cleanupOnExit);
process.on("SIGINT", async () => {
  await cleanupOnExit();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await cleanupOnExit();
  process.exit(0);
});

/**
 * Get stats about tracked temp files/dirs (for debugging)
 */
export function getTempStats(): { files: number; dirs: number } {
  return {
    files: tempFiles.size,
    dirs: tempDirs.size,
  };
}
