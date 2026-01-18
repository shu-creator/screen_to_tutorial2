import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { uploadRouter } from "../uploadRoute";
import { sdk } from "./sdk";
import type { MaybeAuthenticatedRequest } from "../types";

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

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Trust proxy for platforms like Manus that use reverse proxy
  app.set("trust proxy", 1);

  // Configure body parser with larger size limit for file uploads
  // Base64エンコーディングは約33%のオーバーヘッドがあるため、500MBのファイルには約700MBが必要
  app.use(express.json({ limit: "700mb" }));
  app.use(express.urlencoded({ limit: "700mb", extended: true }));
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
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
