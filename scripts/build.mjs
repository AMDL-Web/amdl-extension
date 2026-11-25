import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  sourcemap: false,
  target: "chrome124",
  logLevel: "info",
};

const entries = [
  { in: "src/background/sw.ts", out: "background/sw", format: "esm" },
  { in: "src/offscreen/offscreen.ts", out: "offscreen/offscreen", format: "esm" },
  { in: "src/offscreen/fairplay-worker.ts", out: "offscreen/fairplay-worker", format: "iife" },
  { in: "src/content/main-world.ts", out: "content/main-world", format: "iife" },
  { in: "src/content/inject.ts", out: "content/inject", format: "iife" },
  { in: "src/popup/popup.ts", out: "popup/popup", format: "esm" },
  { in: "src/options/options.ts", out: "options/options", format: "esm" },
];

await Promise.all(
  entries
    .filter((entry) => existsSync(path.join(root, entry.in)))
    .map((entry) =>
      esbuild.build({
        ...common,
        entryPoints: [path.join(root, entry.in)],
        outfile: path.join(dist, `${entry.out}.js`),
        format: entry.format,
      }),
    ),
);

const staticCopies = [
  ["src/manifest.json", "manifest.json"],
  ["src/offscreen/offscreen.html", "offscreen/offscreen.html"],
  ["src/popup/popup.html", "popup/popup.html"],
  ["src/popup/popup.css", "popup/popup.css"],
  ["src/options/options.html", "options/options.html"],
  ["src/options/options.css", "options/options.css"],
  ["src/wasm/temari.wasm", "temari.wasm"],
  ["src/icons", "icons"],
];

for (const [from, to] of staticCopies) {
  const srcPath = path.join(root, from);
  if (existsSync(srcPath)) {
    const destPath = path.join(dist, to);
    mkdirSync(path.dirname(destPath), { recursive: true });
    cpSync(srcPath, destPath, { recursive: true });
  }
}
