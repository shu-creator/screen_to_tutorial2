import { spawn } from "child_process";
import { createInterface } from "readline";
import {
  isLocalStorageUrl,
  resolveLocalStoragePathFromUrl,
} from "../../storage";
import { ENV } from "../../_core/env";
import { buildChunkUserContent, SYSTEM_PROMPT } from "../prompt";
import { AUTHORING_JSON_SCHEMA } from "../schema";
import { parseAuthoringResponseText } from "./json";
import type { AuthoringMessageContent } from "../prompt";
import type { AuthoringProvider, AuthoringProviderInput } from "./types";

type RequestId = number;

type JsonObject = Record<string, unknown>;

type ChildProcessLike = {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill: (signal?: NodeJS.Signals) => boolean;
  once: (
    event: "close" | "exit" | "error",
    listener: (...args: unknown[]) => void
  ) => unknown;
};

type SpawnAppServer = () => ChildProcessLike;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type TurnWaiter = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; detail: "high" | "original"; url: string }
  | { type: "localImage"; detail: "high" | "original"; path: string };

const DEFAULT_TIMEOUT_MS = 180_000;

function getTimeoutMs(): number {
  const raw = process.env.CODEX_APP_SERVER_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function buildCodexAppServerArgs(codexModel = ENV.codexModel): string[] {
  const args = ["app-server", "--listen", "stdio://"];
  const model = codexModel.trim();
  if (model.length > 0) {
    args.push("-c", `model=${model}`);
  }
  return args;
}

function defaultSpawnAppServer(): ChildProcessLike {
  return spawn("codex", buildCodexAppServerArgs(), {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function makeClientRequest(
  method: string,
  id: RequestId,
  params: unknown
): JsonObject {
  return params === undefined ? { method, id } : { method, id, params };
}

function makeTextInput(text: string): CodexUserInput {
  return { type: "text", text, text_elements: [] };
}

function imageDetail(): "high" {
  return "high";
}

function toLocalImagePath(url: string): string | null {
  if (isLocalStorageUrl(url)) {
    return resolveLocalStoragePathFromUrl(url);
  }
  if (
    url.startsWith("/") &&
    !url.startsWith("//") &&
    !url.startsWith("/api/")
  ) {
    return url;
  }
  return null;
}

function toCodexImageInput(url: string): CodexUserInput {
  const localPath = toLocalImagePath(url);
  if (localPath) {
    return { type: "localImage", detail: imageDetail(), path: localPath };
  }
  return { type: "image", detail: imageDetail(), url };
}

function toCodexUserInput(
  content: AuthoringMessageContent[]
): CodexUserInput[] {
  return content.map(part => {
    if (part.type === "text") {
      return makeTextInput(part.text);
    }
    return toCodexImageInput(part.image_url.url);
  });
}

function serverRequestResult(method: string): JsonObject {
  if (method === "item/commandExecution/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "item/fileChange/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return { decision: "denied" };
  }
  if (method === "item/tool/requestUserInput") {
    return { answers: {} };
  }
  if (method === "mcpServer/elicitation/request") {
    return { action: "decline", content: null, _meta: null };
  }
  if (method === "item/tool/call") {
    return { contentItems: [], success: false };
  }
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn", strictAutoReview: true };
  }
  if (method === "account/chatgptAuthTokens/refresh") {
    throw new Error("Codex App Server requested ChatGPT token refresh");
  }
  if (method === "attestation/generate") {
    throw new Error("Codex App Server requested attestation");
  }
  throw new Error(`Unsupported Codex App Server request: ${method}`);
}

class CodexAppServerJsonlClient {
  private readonly child: ChildProcessLike;
  private readonly timeoutMs: number;
  private nextId = 1;
  private stderr = "";
  private closed = false;
  private closeError: Error | null = null;
  private pending = new Map<string, PendingRequest>();
  private turnWaiters = new Map<string, TurnWaiter[]>();
  private completedTurns = new Map<
    string,
    { status: string; error: string | null }
  >();
  private messageDeltas = new Map<string, string>();
  private finalMessages = new Map<string, string>();

  constructor(
    options: {
      spawnAppServer?: SpawnAppServer;
      timeoutMs?: number;
    } = {}
  ) {
    this.child = (options.spawnAppServer ?? defaultSpawnAppServer)();
    this.timeoutMs = options.timeoutMs ?? getTimeoutMs();

    const stdoutLines = createInterface({ input: this.child.stdout });
    stdoutLines.on("line", line => this.handleLine(line));
    this.child.stderr.on("data", chunk => {
      this.stderr += Buffer.from(chunk).toString("utf8");
    });
    this.child.stdin.on("error", () => {
      // The app-server process may already be closing; pending requests are
      // rejected through handleClose/close, so stdin EPIPE is not actionable.
    });
    this.child.once("close", () => this.handleClose());
    this.child.once("exit", () => this.handleClose());
    this.child.once("error", error => {
      this.handleClose(
        error instanceof Error ? error : new Error(String(error))
      );
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "tutorialgen",
        title: "TutorialGen",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.write({ method: "initialized" });
  }

  async startThread(): Promise<string> {
    const result = (await this.request("thread/start", {
      cwd: process.cwd(),
      runtimeWorkspaceRoots: [process.cwd()],
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      serviceName: "tutorialgen-authoring",
      baseInstructions:
        "You are an API-free authoring engine for TutorialGen. Do not run shell commands, edit files, or ask questions. Return the requested JSON only.",
      developerInstructions: `${SYSTEM_PROMPT}\n\n最終応答は tutorial_authoring schema に合うJSONオブジェクトだけにしてください。Markdown、コードフェンス、説明文を含めないでください。`,
      threadSource: "user",
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })) as { thread?: { id?: unknown } };

    const threadId = result.thread?.id;
    if (typeof threadId !== "string" || threadId.length === 0) {
      throw new Error("Codex App Server did not return a thread id");
    }
    return threadId;
  }

  async startTurnAndWait(
    threadId: string,
    input: CodexUserInput[]
  ): Promise<string> {
    const result = (await this.request("turn/start", {
      threadId,
      input: [
        makeTextInput(
          "以下の証拠から tutorial_authoring JSON を返してください。最終応答はJSONオブジェクトだけにしてください。"
        ),
        ...input,
      ],
      cwd: process.cwd(),
      runtimeWorkspaceRoots: [process.cwd()],
      approvalPolicy: "never",
      // App Server uses thread-level `sandbox` and turn-level `sandboxPolicy`.
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: AUTHORING_JSON_SCHEMA.schema,
    })) as { turn?: { id?: unknown } };

    const turnId = result.turn?.id;
    if (typeof turnId !== "string" || turnId.length === 0) {
      throw new Error("Codex App Server did not return a turn id");
    }
    return this.waitForTurn(threadId, turnId);
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.rejectAllPending(
        new Error("Codex App Server process closed by client")
      );
      this.child.kill("SIGTERM");
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("Codex App Server process is closed"));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.write(makeClientRequest(method, id, params));
    });
  }

  private waitForTurn(threadId: string, turnId: string): Promise<string> {
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new Error("Codex App Server process is closed")
      );
    }

    const completed = this.completedTurns.get(turnId);
    if (completed) {
      return this.resolveCompletedTurn(turnId, completed);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.turnWaiters.get(turnId) ?? [];
        this.turnWaiters.set(
          turnId,
          waiters.filter(waiter => waiter.resolve !== resolve)
        );
        reject(
          new Error(`Codex App Server turn timed out: ${threadId}/${turnId}`)
        );
      }, this.timeoutMs);
      const waiters = this.turnWaiters.get(turnId) ?? [];
      waiters.push({ resolve, reject, timer });
      this.turnWaiters.set(turnId, waiters);
    });
  }

  private resolveCompletedTurn(
    turnId: string,
    completed: { status: string; error: string | null }
  ): Promise<string> {
    if (completed.status !== "completed") {
      return Promise.reject(
        new Error(
          `Codex App Server turn ${completed.status}: ${completed.error ?? "unknown error"}`
        )
      );
    }
    const text =
      this.finalMessages.get(turnId) ?? this.messageDeltas.get(turnId) ?? "";
    if (text.trim().length === 0) {
      return Promise.reject(new Error("Codex App Server response was empty"));
    }
    return Promise.resolve(text);
  }

  private completeTurn(
    turnId: string,
    completed: { status: string; error: string | null }
  ): void {
    this.completedTurns.set(turnId, completed);
    const waiters = this.turnWaiters.get(turnId) ?? [];
    this.turnWaiters.delete(turnId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      void this.resolveCompletedTurn(turnId, completed).then(
        waiter.resolve,
        waiter.reject
      );
    }
  }

  private handleLine(line: string): void {
    if (this.closed) return;
    if (!line.trim()) return;

    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }

    if ("id" in message && ("result" in message || "error" in message)) {
      this.handleResponse(message);
      return;
    }

    if ("id" in message && typeof message.method === "string") {
      this.handleServerRequest(message);
      return;
    }

    if (typeof message.method === "string") {
      this.handleNotification(message);
    }
  }

  private handleResponse(message: JsonObject): void {
    const id = String(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (message.error) {
      const error =
        typeof message.error === "object" && message.error !== null
          ? (message.error as { message?: unknown }).message
          : message.error;
      pending.reject(
        new Error(
          `Codex App Server request failed: ${typeof error === "string" ? error : JSON.stringify(message.error)}`
        )
      );
      return;
    }

    pending.resolve(message.result);
  }

  private handleServerRequest(message: JsonObject): void {
    const id = message.id;
    const method = String(message.method);
    try {
      this.write({ id, result: serverRequestResult(method) });
    } catch (error) {
      const fatalError =
        error instanceof Error ? error : new Error(String(error));
      this.write({
        id,
        error: {
          code: -32000,
          message: fatalError.message,
        },
      });
      this.handleClose(fatalError);
      this.child.kill("SIGTERM");
    }
  }

  private handleNotification(message: JsonObject): void {
    if (message.method === "item/agentMessage/delta") {
      const params = message.params as { turnId?: unknown; delta?: unknown };
      if (
        typeof params?.turnId === "string" &&
        typeof params.delta === "string"
      ) {
        this.messageDeltas.set(
          params.turnId,
          `${this.messageDeltas.get(params.turnId) ?? ""}${params.delta}`
        );
      }
      return;
    }

    if (message.method === "item/completed") {
      const params = message.params as {
        turnId?: unknown;
        item?: { type?: unknown; text?: unknown };
      };
      if (
        typeof params?.turnId === "string" &&
        params.item?.type === "agentMessage" &&
        typeof params.item.text === "string"
      ) {
        this.finalMessages.set(params.turnId, params.item.text);
      }
      return;
    }

    if (message.method === "turn/completed") {
      const params = message.params as {
        turn?: {
          id?: unknown;
          status?: unknown;
          error?: { message?: unknown; additionalDetails?: unknown } | null;
        };
      };
      const turn = params?.turn;
      if (!turn || typeof turn.id !== "string") return;
      const turnId = turn.id;
      const error = turn.error
        ? [
            typeof turn.error.message === "string" ? turn.error.message : null,
            typeof turn.error.additionalDetails === "string"
              ? turn.error.additionalDetails
              : null,
          ]
            .filter(Boolean)
            .join(": ")
        : null;
      this.completeTurn(turnId, {
        status: typeof turn.status === "string" ? turn.status : "failed",
        error,
      });
    }
  }

  private handleClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const message =
      error?.message ??
      `Codex App Server process closed${this.stderr.trim() ? `: ${this.stderr.trim().slice(0, 500)}` : ""}`;
    this.rejectAllPending(new Error(message));
  }

  private rejectAllPending(error: Error): void {
    this.closeError = error;
    this.pending.forEach(pending => {
      clearTimeout(pending.timer);
      pending.reject(error);
    });
    this.pending.clear();

    this.turnWaiters.forEach(waiters => {
      waiters.forEach(waiter => {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      });
    });
    this.turnWaiters.clear();
  }

  private write(message: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

export function createCodexAppServerAuthoringProvider(
  options: {
    spawnAppServer?: SpawnAppServer;
    timeoutMs?: number;
  } = {}
): AuthoringProvider {
  return {
    async invokeChunk({
      globalContext,
      chunk,
      interimOverview,
    }: AuthoringProviderInput) {
      const client = new CodexAppServerJsonlClient(options);
      try {
        await client.initialize();
        const threadId = await client.startThread();
        const input = toCodexUserInput(
          buildChunkUserContent(globalContext, chunk, interimOverview)
        );
        const rawText = await client.startTurnAndWait(threadId, input);
        return parseAuthoringResponseText(rawText);
      } finally {
        client.close();
      }
    },
  };
}

export const _codexAppServerTestInternals = {
  CodexAppServerJsonlClient,
  buildCodexAppServerArgs,
  toCodexUserInput,
};
