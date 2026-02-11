import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import superjson from "superjson";
import App from "./App";
import { getAuthMode, getLoginUrl } from "./const";
import "./index.css";

const queryClient = new QueryClient();
const shownMissingApiKeyHints = new Set<"llm" | "tts">();

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;
  if (getAuthMode() === "none") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;

  window.location.href = getLoginUrl();
};

const showMissingApiKeyHint = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;

  const message = error.message ?? "";
  let keyType: "llm" | "tts" | null = null;

  if (message.includes("LLM API key is not configured")) {
    keyType = "llm";
  } else if (message.includes("TTS API key is not configured")) {
    keyType = "tts";
  }

  if (!keyType || shownMissingApiKeyHints.has(keyType)) return;

  shownMissingApiKeyHints.add(keyType);
  const serviceName = keyType === "llm" ? "LLM" : "TTS";
  toast.error(
    `${serviceName} APIキーが未設定です。設定画面で状態を確認し、.env を更新してサーバーを再起動してください。`,
  );
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    showMissingApiKeyHint(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    showMissingApiKeyHint(error);
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
