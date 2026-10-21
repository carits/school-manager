const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = process.cwd();
const indexPath = path.join(root, "index.html");
const sportsIndexPath = path.join(root, "sports-meet.html");
const original = fs.readFileSync(indexPath);
fs.copyFileSync(sportsIndexPath, indexPath);
let result;
try {
  result = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--mode", "web"], {
    stdio: "inherit",
    env: { ...process.env, VITE_BUILD_TARGET: "sports-meet" },
  });
} finally {
  fs.writeFileSync(indexPath, original);
}
if (result?.error) console.error(result.error);
process.exit(result?.status ?? 1);
