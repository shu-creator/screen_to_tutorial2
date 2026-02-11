import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/contexts/ThemeContext";
import { trpc } from "@/lib/trpc";
import { LogOut, Moon, Server, Sun, User } from "lucide-react";

export default function Settings() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme, switchable } = useTheme();
  const {
    data: systemInfo,
    isLoading: systemInfoLoading,
    error: systemInfoError,
  } = trpc.system.info.useQuery();

  const llmKeyHint =
    systemInfo?.llmProvider === "openai"
      ? "LLM_API_KEY または OPENAI_API_KEY"
      : systemInfo?.llmProvider === "gemini"
        ? "LLM_API_KEY または GEMINI_API_KEY"
        : "LLM_API_KEY または ANTHROPIC_API_KEY";

  const ttsKeyHint =
    systemInfo?.ttsProvider === "openai"
      ? "TTS_API_KEY または OPENAI_API_KEY"
      : "TTS_API_KEY または GEMINI_API_KEY";

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold">設定</h1>
          <p className="text-muted-foreground">アカウントとアプリケーションの設定を管理します</p>
        </div>

        {/* Profile Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              プロフィール
            </CardTitle>
            <CardDescription>
              アカウント情報を確認できます
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">名前</Label>
              <p className="font-medium">{user?.name || "-"}</p>
            </div>
            <div className="grid gap-2">
              <Label className="text-muted-foreground">メールアドレス</Label>
              <p className="font-medium">{user?.email || "-"}</p>
            </div>
          </CardContent>
        </Card>

        {/* Appearance Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {theme === "dark" ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
              外観
            </CardTitle>
            <CardDescription>
              アプリケーションの表示設定を変更します
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="dark-mode">ダークモード</Label>
                <p className="text-sm text-muted-foreground">
                  ダークテーマを使用します
                </p>
              </div>
              {switchable ? (
                <Switch
                  id="dark-mode"
                  checked={theme === "dark"}
                  onCheckedChange={toggleTheme}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  現在 {theme === "dark" ? "ダーク" : "ライト"} モード
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              システム
            </CardTitle>
            <CardDescription>
              現在の認証モードとAIプロバイダー設定
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {systemInfoLoading && (
              <p className="text-sm text-muted-foreground">設定情報を読み込み中です...</p>
            )}
            {systemInfoError && (
              <p className="text-sm text-destructive">設定情報の取得に失敗しました</p>
            )}
            {systemInfo && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md border p-3 space-y-1">
                    <p className="text-sm text-muted-foreground">認証モード</p>
                    <p className="font-medium">{systemInfo.authMode}</p>
                  </div>
                  <div className="rounded-md border p-3 space-y-1">
                    <p className="text-sm text-muted-foreground">実行環境</p>
                    <p className="font-medium">
                      {systemInfo.isProduction ? "production" : "development"}
                    </p>
                  </div>
                  <div className="rounded-md border p-3 space-y-1">
                    <p className="text-sm text-muted-foreground">LLM</p>
                    <p className="font-medium">
                      {systemInfo.llmProvider} / {systemInfo.llmModel}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      APIキー: {systemInfo.llmApiKeyConfigured ? "設定済み" : "未設定"}
                    </p>
                  </div>
                  <div className="rounded-md border p-3 space-y-1">
                    <p className="text-sm text-muted-foreground">TTS</p>
                    <p className="font-medium">
                      {systemInfo.ttsProvider} / {systemInfo.ttsModel}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      APIキー: {systemInfo.ttsApiKeyConfigured ? "設定済み" : "未設定"}
                    </p>
                  </div>
                </div>

                {(!systemInfo.llmApiKeyConfigured || !systemInfo.ttsApiKeyConfigured) && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
                    <p className="text-sm font-medium">APIキーの設定が不足しています</p>
                    <p className="text-sm mt-1">
                      サーバーの <code>.env</code> を更新して再起動してください。
                    </p>
                    {!systemInfo.llmApiKeyConfigured && (
                      <p className="text-sm mt-1">LLM: {llmKeyHint}</p>
                    )}
                    {!systemInfo.ttsApiKeyConfigured && (
                      <p className="text-sm mt-1">TTS: {ttsKeyHint}</p>
                    )}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Account Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LogOut className="h-5 w-5" />
              アカウント
            </CardTitle>
            <CardDescription>
              アカウント管理
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="destructive"
              onClick={logout}
              className="w-full sm:w-auto"
            >
              <LogOut className="h-4 w-4 mr-2" />
              サインアウト
            </Button>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
