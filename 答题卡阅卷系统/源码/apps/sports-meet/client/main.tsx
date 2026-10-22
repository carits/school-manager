/// <reference types="vite/client" />

import React from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "../../answer-card/client/auth/AuthContext";
import { ErrorBoundary } from "../../answer-card/client/components/ErrorBoundary";
import { LoginPage } from "../../answer-card/client/components/LoginPage";
import { SportsMeetPage } from "../../answer-card/client/pages/SportsMeetPage";
import "../../answer-card/client/theme/app.css";
import "../../answer-card/client/theme/backdrop.css";

try {
  const storedTheme = localStorage.getItem("projectx-theme");
  document.documentElement.setAttribute("data-theme", storedTheme === "dark" ? "dark" : "light");
} catch {
  document.documentElement.setAttribute("data-theme", "light");
}
try {
  const storedSkin = localStorage.getItem("projectx-skin");
  if (storedSkin) document.documentElement.dataset.skin = storedSkin;
} catch {
  /* private browsing / storage disabled */
}

document.title = "运动会成绩管理";

function SportsMeetEntry() {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">正在检查登录状态...</div>;
  if (!user) return <LoginPage />;
  return <SportsMeetPage />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <SportsMeetEntry />
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
