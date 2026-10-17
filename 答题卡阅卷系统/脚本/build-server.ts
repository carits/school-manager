import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await build({
  entryPoints: ["源码/apps/answer-card/server/index.ts"],
  outfile: "dist/server/index.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: false,
  logLevel: "info"
});

await mkdir("dist/server", { recursive: true });
await copyFile("源码/server/db/schema.sql", "dist/server/schema.sql");
await copyFile("源码/server/db/schema.mariadb.sql", "dist/server/schema.mariadb.sql");

console.log("[build:server] schema.sql + schema.mariadb.sql copied");
