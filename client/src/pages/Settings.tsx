import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/contexts/ThemeContext";
import { LogOut, Moon, Sun, User } from "lucide-react";

export default function Settings() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme, switchable } = useTheme();

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
