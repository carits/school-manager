/// <reference types="vite/client" />

import "./polyfills";
import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import WenjuanApp from "./WenjuanApp";
import LegacyPdfApp from "./pages/LegacyPdfApp";
import ReviewTaskApp from "./ReviewTaskApp";
import { AuthProvider } from "./auth/AuthContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
// 唯一样式入口：app.css 内部按 theme < base < components < utilities 的层序引入 tokens.css，顺序不得在此绕过。
import "./theme/app.css";
// 背景图浮层（从旧 styles.css 迁出的功能性样式，非遗留装饰；v2.0.0 起独立文件）
import "./theme/backdrop.css";

// Match the demo's theme before React paints, avoiding a light-frame flash for dark users.
try {
  const storedTheme = localStorage.getItem((import.meta.env.VITE_LEGACY_ONLY === "1" ? (import.meta.env.VITE_LEGACY_ONLY === "1" ? 'legacy-old-theme' : 'projectx-theme') : 'projectx-theme'));
  document.documentElement.setAttribute("data-theme", storedTheme === "dark" ? "dark" : "light");
} catch {
  document.documentElement.setAttribute("data-theme", "light");
}

// v2.1.0: 皮肤预置（皮肤=风格维度，与明暗正交）。v2.3.0 起默认皮肤 = 'paper-edge'，
// 其 CSS 覆盖块依赖 data-skin 属性，故 localStorage 有记录即设置（含默认值），防白闪。
try {
  const storedSkin = localStorage.getItem((import.meta.env.VITE_LEGACY_ONLY === "1" ? (import.meta.env.VITE_LEGACY_ONLY === "1" ? 'legacy-old-skin' : 'projectx-skin') : 'projectx-skin'));
  if (storedSkin) {
    document.documentElement.dataset.skin = storedSkin;
  }
} catch {
  /* private browsing / storage disabled */
}

// This is the web mode entry point (teacher + student, no scanner panel).
// Used in dev (npm run dev) and in web builds (vite build --mode web).
// Phase 2: 数据路由（createBrowserRouter）让每个工作模式 = 真实 URL，
// 并且使 useBlocker（未保存离开确认）能真正拦截导航。App 内部按 URL 渲染对应模式。

const router = createBrowserRouter([
  {
    path: "*",
    element: <App />,
  },
], { basename: "/answer-card" });

const isWenjuan = typeof window !== "undefined" && /^\/wenjuan(?:\/|$)/.test(window.location.pathname);
const isLegacyPdf = typeof window !== "undefined" && /^\/answer-card\/custom-pdf(?:\/|$)/.test(window.location.pathname);
const isReviewTask = typeof window !== "undefined" && /^\/answer-card\/review(?:\/|$)/.test(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        {isReviewTask ? <ReviewTaskApp /> : isLegacyPdf ? <LegacyPdfApp /> : isWenjuan ? <WenjuanApp /> : <><RouterProvider router={router} /><a href="/answer-card/custom-pdf/" className="fixed bottom-5 right-5 z-40 rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground shadow-lg">自定义 PDF 扫描阅卷</a></>}
      </AuthProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
