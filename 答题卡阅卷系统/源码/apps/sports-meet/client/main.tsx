/// <reference types="vite/client" />

import React from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "../../answer-card/client/components/ErrorBoundary";
import { SportsMeetPage } from "../../answer-card/client/pages/SportsMeetPage";
import "../../answer-card/client/theme/app.css";
import "../../answer-card/client/theme/backdrop.css";

try {
  const storedTheme = localStorage.getItem("sports-meet-theme");
  document.documentElement.setAttribute("data-theme", storedTheme === "dark" ? "dark" : "light");
} catch {
  document.documentElement.setAttribute("data-theme", "light");
}

document.title = "中雅实验学校2026秋季运动会";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SportsMeetPage />
    </ErrorBoundary>
  </React.StrictMode>
);
