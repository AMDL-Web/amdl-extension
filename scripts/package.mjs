// Zips dist/ as release/amdl-extension-v<version>.zip (top-level folder
// "amdl-extension/") and writes release/SHA256SUMS. Run after `pnpm build`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "manifest.json"))) {
  throw new Error("dist/ is missing; run `pnpm build` first");
}
const { version } = JSON.parse(
  readFileSync(path.join(dist, "manifest.json"), "utf8"),
);
const outDir = path.join(root, "release");
const stage = path.join(outDir, "stage");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(dist, path.join(stage, "amdl-extension"), { recursive: true });

const zipName = `amdl-extension-v${version}.zip`;
execFileSync("zip", ["-qrX", path.join(outDir, zipName), "amdl-extension"], {
  cwd: stage,
  stdio: "inherit",
});
rmSync(stage, { recursive: true, force: true });

const sha = createHash("sha256")
  .update(readFileSync(path.join(outDir, zipName)))
  .digest("hex");
writeFileSync(path.join(outDir, "SHA256SUMS"), `${sha}  ${zipName}\n`);
console.log(`${zipName}\n${sha}`);
