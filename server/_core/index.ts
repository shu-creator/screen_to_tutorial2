import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import net from "net";
import { nanoid } from "nanoid";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import type { ViteDevServer } from "vite";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { uploadRouter } from "../uploadRoute";
import { ENV } from "./env";
import { getHealth } from "./health";
import { ensureStorageDir } from "../storage";
import { createLogger } from "./logger";
import { sdk } from "./sdk";
import type { MaybeAuthenticatedRequest } from "../types";

const logger = createLogger("Server");
const httpLogger = createLogger("HTTP");
const SHUTDOWN_TIMEOUT_MS = 10_000;

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

function shouldSkipAccessLog(pathname: string): boolean {
  return (
    pathname === "/api/health" ||
    pathname.startsWith("/api/storage") ||
    pathname.startsWith("/storage")
  );
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      const err = error as NodeJS.ErrnoException | undefined;
      if (err && err.code !== "ERR_SERVER_NOT_RUNNING") {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function registerGracefulShutdown(
  server: Server,
  viteServer: ViteDevServer | null,
): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`Received ${signal}, starting graceful shutdown`);

    const forceExitTimer = setTimeout(() => {
      logger.error("Graceful shutdown timed out");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    try {
      await closeHttpServer(server);
      if (viteServer) {
        await viteServer.close();
      }
      clearTimeout(forceExitTimer);
      logger.info("Graceful shutdown completed");
      process.exit(0);
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      logger.error("Graceful shutdown failed", undefined, normalizedError);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

async function startServer() {
  await ensureStorageDir();

  const app = express();
  const server = createServer(app);
  let viteServer: ViteDevServer | null = null;

  // Trust proxy for deployments that run behind a reverse proxy
  app.set("trust proxy", 1);

  // Configure body parser with larger size limit for file uploads
  // Base64エンコーディングは約33%のオーバーヘッドがあるため、500MBのファイルには約700MBが必要
  app.use(express.json({ limit: "700mb" }));
  app.use(express.urlencoded({ limit: "700mb", extended: true }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const pathname = req.path || req.originalUrl.split("?")[0];
    if (!pathname.startsWith("/api/") || shouldSkipAccessLog(pathname)) {
      next();
      return;
    }

    const startedAt = Date.now();
    const requestId = req.header("x-request-id")?.trim() || nanoid(10);
    res.setHeader("X-Request-Id", requestId);

    res.on("finish", () => {
      const durationMs = Date.now() - startedAt;
      const status = res.statusCode;
      const context = {
        method: req.method,
        path: pathname,
        status,
        durationMs,
        ip: req.ip,
        requestId,
      };

      if (status >= 500) {
        httpLogger.error("HTTP request failed", context);
      } else if (status >= 400 || durationMs > 2_000) {
        httpLogger.warn("HTTP request warning", context);
      } else {
        httpLogger.info("HTTP request", context);
      }
    });

    next();
  });

  app.get("/api/health", async (_req: Request, res: Response) => {
    try {
      const health = await getHealth();
      res.status(health.ok ? 200 : 503).json(health);
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      logger.error("Health endpoint failed", undefined, normalizedError);
      res.status(503).json({
        ok: false,
        timestamp: new Date().toISOString(),
        error: "Health check failed",
      });
    }
  });

  app.use(
    "/api/storage",
    express.static(ENV.storageDir, {
      dotfiles: "deny",
      index: false,
      fallthrough: false,
      setHeaders: (res) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
      },
    })
  );

  app.use(
    "/storage",
    express.static(ENV.storageDir, {
      dotfiles: "deny",
      index: false,
      fallthrough: false,
      setHeaders: (res) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
      },
    })
  );

  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);

  // Authentication middleware for upload routes
  const authenticateUpload = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await sdk.authenticateRequest(req);
      (req as MaybeAuthenticatedRequest).user = user;
      next();
    } catch (error) {
      res.status(401).json({ error: "認証が必要です" });
    }
  };

  // File upload API (multipart/form-data)
  app.use("/api/upload", authenticateUpload, uploadRouter);

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    viteServer = await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    logger.info(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    logger.info(`Server running on http://localhost:${port}/`);
  });

  registerGracefulShutdown(server, viteServer);
}

startServer().catch((error: unknown) => {
  const normalizedError =
    error instanceof Error ? error : new Error(String(error));
  logger.error("Failed to start server", undefined, normalizedError);
});
