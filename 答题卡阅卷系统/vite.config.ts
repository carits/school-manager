import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Web SPA: iOS 15 / Safari 15+ (see browserslist in package.json). */
const WEB_BUILD_TARGET = ["es2020", "safari15"] as const;

// Two build targets:
//   vite build --mode web     -> dist/web/ (teacher + student, no scanner)
//   vite build --mode scanner -> dist/scanner/ (ScannerPanel only, for Electron)
// Default (no --mode) -> web (development)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = process.cwd();
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
) as { version?: string };

export default defineConfig(({ mode }) => {
  const isScanner = mode === "scanner";
  const isSportsMeet = process.env.VITE_BUILD_TARGET === "sports-meet";
  const buildTarget = isScanner ? "scanner" : isSportsMeet ? "sports-meet" : "web";
  const scannerOutDir = path.join(projectRoot, "dist", "scanner");
  const sportsMeetOutDir = path.join(projectRoot, "dist", "sports-meet");

  return {
    // The legacy root page is served at /answer-card/, but its assets must use
    // the old app route. /answer-card/assets/ belongs to the protected service.
    base: isScanner ? "/" : isSportsMeet ? "/sports-meet/" : process.env.VITE_LEGACY_ONLY === "1" ? "/answer-card/legacy-api/" : "/answer-card/",
    publicDir: "公共资源",
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "projectx-scanner-index-html",
        closeBundle() {
          if (!isScanner) return;
          const source = path.join(scannerOutDir, "index-scanner.html");
          const target = path.join(scannerOutDir, "index.html");
          if (fs.existsSync(source)) {
            fs.renameSync(source, target);
          }
        }
      }
    ],
    define: {
      // Compile-time constant so Vite can tree-shake scanner code from web builds
      "import.meta.env.VITE_BUILD_TARGET": JSON.stringify(buildTarget),
      "import.meta.env.VITE_LEGACY_ONLY": JSON.stringify(process.env.VITE_LEGACY_ONLY === "1" ? "1" : "0"),
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(packageJson.version ?? "0.0.0")
    },
    server: {
      port: 5173,
      strictPort: true,
      // Dev perf: pre-transform the first-screen module graph on startup
      warmup: {
        clientFiles: ["./源码/apps/answer-card/client/main.tsx"]
      },
      // Dev perf: keep chokidar away from large non-frontend directories
      watch: {
        ignored: [
          "**/.npm-cache/**",
          "**/.qoder/**",
          "**/.omo/**",
          "**/data/**",
          "**/测试数据/**",
          "**/release/**",
          "**/运行资源/**",
          "**/build/**",
          "**/readus/**",
          "**/input/**",
          "**/native/**",
          "**/llmclient/**"
        ]
      },
      proxy: {
        "/api": "http://127.0.0.1:5174",
        "/assets": "http://127.0.0.1:5174"
      }
    },
    build: {
      outDir: isScanner ? scannerOutDir : isSportsMeet ? sportsMeetOutDir : "dist/web",
      assetsDir: process.env.VITE_LEGACY_ONLY === "1" ? "legacy-pdf-assets" : "assets",
      target: isScanner ? undefined : [...WEB_BUILD_TARGET],
      ...(isScanner ? {
        rollupOptions: {
          input: path.resolve(projectRoot, "index-scanner.html")
        }
      } : {})
    }
  };
});
