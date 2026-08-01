import { build } from "esbuild";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(projectDir, "dist");
const sourceDir = path.join(projectDir, "src");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const commonOptions = {
  bundle: true,
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
};

await Promise.all([
  build({
    ...commonOptions,
    entryPoints: [path.join(sourceDir, "background.ts")],
    outfile: path.join(distDir, "background.js"),
    format: "esm",
  }),
  build({
    ...commonOptions,
    entryPoints: [path.join(sourceDir, "content.ts")],
    outfile: path.join(distDir, "content.js"),
    format: "iife",
  }),
  build({
    ...commonOptions,
    entryPoints: [path.join(sourceDir, "oauth-callback.ts")],
    outfile: path.join(distDir, "oauth-callback.js"),
    format: "iife",
  }),
  build({
    ...commonOptions,
    entryPoints: [path.join(sourceDir, "sidepanel.ts")],
    outfile: path.join(distDir, "sidepanel.js"),
    format: "iife",
  }),
]);

await Promise.all(
  ["manifest.json", "sidepanel.html", "sidepanel.css"].map((file) =>
    copyFile(path.join(projectDir, file), path.join(distDir, file)),
  ),
);

await cp(path.join(projectDir, "icons"), path.join(distDir, "icons"), {
  recursive: true,
});

console.log(`Extension built at ${distDir}`);
