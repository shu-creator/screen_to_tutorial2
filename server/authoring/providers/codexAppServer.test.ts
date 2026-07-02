import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { describe, expect, it, vi } from "vitest";
import {
  _codexAppServerTestInternals,
  createCodexAppServerAuthoringProvider,
} from "./codexAppServer";

const invokeLLMMock = vi.hoisted(() => vi.fn());
vi.mock("../../_core/llm", () => ({ invokeLLM: invokeLLMMock }));

function validResponseText(): string {
  return JSON.stringify({
    overview: {
      task_title: "ログイン",
      preconditions: [],
      completion_criteria: "ホームが表示される",
    },
    steps: [
      {
        source_segment_ids: ["seg-1"],
        title: "ログインする",
        instruction: "ログインする",
        expected_result: "ホームが表示される",
        operation: "クリック",
        description: "ログインボタンを押す",
        narration: "ログインします",
        cited_ui_labels: [],
      },
    ],
    discarded_segments: [],
  });
}

function makeFakeAppServer(
  responseText: string,
  options: {
    sendServerRequest?: boolean;
    serverRequestMethod?: string;
    turnStatus?: "completed" | "failed";
  } = {}
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  const requests: Array<Record<string, unknown>> = [];
  let buffered = "";

  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn(() => true);

  function send(message: Record<string, unknown>) {
    stdout.write(`${JSON.stringify(message)}\n`);
  }

  function handleRequest(request: Record<string, unknown>) {
    requests.push(request);
    if (!("method" in request)) return;
    const id = request.id;
    if (request.method === "initialize") {
      send({
        id,
        result: {
          userAgent: "fake",
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "macos",
        },
      });
      return;
    }
    if (request.method === "initialized") {
      return;
    }
    if (request.method === "thread/start") {
      send({
        id,
        result: {
          thread: { id: "thread-1" },
          model: "fake",
          modelProvider: "fake",
          serviceTier: null,
          cwd: process.cwd(),
          runtimeWorkspaceRoots: [process.cwd()],
          instructionSources: [],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: { type: "readOnly", networkAccess: false },
          activePermissionProfile: null,
          reasoningEffort: null,
        },
      });
      return;
    }
    if (request.method === "turn/start") {
      send({
        id,
        result: {
          turn: {
            id: "turn-1",
            items: [],
            itemsView: "complete",
            status: "inProgress",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
          },
        },
      });
      queueMicrotask(() => {
        if (options.sendServerRequest) {
          send({
            id: 99,
            method:
              options.serverRequestMethod ??
              "item/commandExecution/requestApproval",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "item-tool-1",
            },
          });
        }
        send({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "item-1",
            delta: `\`\`\`json\n${responseText}\n\`\`\``,
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              items: [],
              itemsView: "complete",
              status: options.turnStatus ?? "completed",
              error:
                options.turnStatus === "failed"
                  ? { message: "model failed" }
                  : null,
              startedAt: 1,
              completedAt: 2,
              durationMs: 100,
            },
          },
        });
      });
    }
  }

  stdin.on("data", chunk => {
    buffered += Buffer.from(chunk).toString("utf8");
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim()) {
        handleRequest(JSON.parse(line) as Record<string, unknown>);
      }
      newline = buffered.indexOf("\n");
    }
  });

  return { child, requests };
}

function makeSilentAppServer() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

function makeClosingAppServer() {
  const child = makeSilentAppServer();
  child.stdin.on("data", () => {
    queueMicrotask(() => child.emit("close", 1));
  });
  return child;
}

describe("Codex App Server authoring provider", () => {
  it("passes CODEX_MODEL through to the app-server model override", () => {
    expect(
      _codexAppServerTestInternals.buildCodexAppServerArgs("gpt-5.4-codex")
    ).toEqual([
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      "model=gpt-5.4-codex",
    ]);
    expect(_codexAppServerTestInternals.buildCodexAppServerArgs("")).toEqual([
      "app-server",
      "--listen",
      "stdio://",
    ]);
  });

  it("uses app-server JSONL and does not call invokeLLM", async () => {
    invokeLLMMock.mockReset();
    const fake = makeFakeAppServer(validResponseText());
    const provider = createCodexAppServerAuthoringProvider({
      spawnAppServer: () => fake.child,
      timeoutMs: 1_000,
    });

    const result = await provider.invokeChunk({
      globalContext: "global context",
      interimOverview: null,
      chunk: {
        chunkIndex: 0,
        totalChunks: 1,
        digests: [
          {
            text: "segment digest",
            imageUrls: ["/api/storage/projects/1/frames/seg-1.jpg"],
            segment: { segment_id: "seg-1" },
          },
        ],
      } as never,
    });

    expect(result.overview.task_title).toBe("ログイン");
    expect(result.steps[0].source_segment_ids).toEqual(["seg-1"]);
    expect(invokeLLMMock).not.toHaveBeenCalled();

    const turnStart = fake.requests.find(
      request => request.method === "turn/start"
    ) as { params: { input: Array<{ type: string }>; outputSchema: unknown } };
    expect(
      turnStart.params.input.some(item => item.type === "localImage")
    ).toBe(true);
    expect(turnStart.params.outputSchema).toMatchObject({
      required: ["overview", "steps", "discarded_segments"],
    });
  });

  it("denies app-server approval requests and continues the turn", async () => {
    const fake = makeFakeAppServer(validResponseText(), {
      sendServerRequest: true,
    });
    const provider = createCodexAppServerAuthoringProvider({
      spawnAppServer: () => fake.child,
      timeoutMs: 1_000,
    });

    await expect(
      provider.invokeChunk({
        globalContext: "global context",
        interimOverview: null,
        chunk: {
          chunkIndex: 0,
          totalChunks: 1,
          digests: [
            {
              text: "segment digest",
              imageUrls: [],
              segment: { segment_id: "seg-1" },
            },
          ],
        } as never,
      })
    ).resolves.toMatchObject({
      overview: { task_title: "ログイン" },
    });

    expect(fake.requests).toContainEqual({
      id: 99,
      result: { decision: "decline" },
    });
  });

  it("aborts immediately when app-server requests unsupported auth refresh", async () => {
    const fake = makeFakeAppServer(validResponseText(), {
      sendServerRequest: true,
      serverRequestMethod: "account/chatgptAuthTokens/refresh",
    });
    const provider = createCodexAppServerAuthoringProvider({
      spawnAppServer: () => fake.child,
      timeoutMs: 1_000,
    });

    await expect(
      provider.invokeChunk({
        globalContext: "global context",
        interimOverview: null,
        chunk: {
          chunkIndex: 0,
          totalChunks: 1,
          digests: [
            {
              text: "segment digest",
              imageUrls: [],
              segment: { segment_id: "seg-1" },
            },
          ],
        } as never,
      })
    ).rejects.toThrow("Codex App Server requested ChatGPT token refresh");

    expect(fake.requests).toContainEqual({
      id: 99,
      error: {
        code: -32000,
        message: "Codex App Server requested ChatGPT token refresh",
      },
    });
    expect(fake.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects schema-invalid Codex output", async () => {
    const fake = makeFakeAppServer(JSON.stringify({ steps: [] }));
    const provider = createCodexAppServerAuthoringProvider({
      spawnAppServer: () => fake.child,
      timeoutMs: 1_000,
    });

    await expect(
      provider.invokeChunk({
        globalContext: "global context",
        interimOverview: null,
        chunk: {
          chunkIndex: 0,
          totalChunks: 1,
          digests: [
            {
              text: "segment digest",
              imageUrls: [],
              segment: { segment_id: "seg-1" },
            },
          ],
        } as never,
      })
    ).rejects.toThrow();
  });

  it("rejects request timeouts and closes the app-server process", async () => {
    const child = makeSilentAppServer();
    const provider = createCodexAppServerAuthoringProvider({
      spawnAppServer: () => child,
      timeoutMs: 20,
    });

    await expect(
      provider.invokeChunk({
        globalContext: "global context",
        interimOverview: null,
        chunk: {
          chunkIndex: 0,
          totalChunks: 1,
          digests: [],
        } as never,
      })
    ).rejects.toThrow("Codex App Server request timed out: initialize");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects process close while a request is pending", async () => {
    const provider = createCodexAppServerAuthoringProvider({
      spawnAppServer: makeClosingAppServer,
      timeoutMs: 1_000,
    });

    await expect(
      provider.invokeChunk({
        globalContext: "global context",
        interimOverview: null,
        chunk: {
          chunkIndex: 0,
          totalChunks: 1,
          digests: [],
        } as never,
      })
    ).rejects.toThrow("Codex App Server process closed");
  });

  it("rejects failed turns", async () => {
    const fake = makeFakeAppServer(validResponseText(), {
      turnStatus: "failed",
    });
    const provider = createCodexAppServerAuthoringProvider({
      spawnAppServer: () => fake.child,
      timeoutMs: 1_000,
    });

    await expect(
      provider.invokeChunk({
        globalContext: "global context",
        interimOverview: null,
        chunk: {
          chunkIndex: 0,
          totalChunks: 1,
          digests: [
            {
              text: "segment digest",
              imageUrls: [],
              segment: { segment_id: "seg-1" },
            },
          ],
        } as never,
      })
    ).rejects.toThrow("Codex App Server turn failed: model failed");
  });
});
