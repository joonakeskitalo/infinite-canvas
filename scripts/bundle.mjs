#!/usr/bin/env bun
/**
 * Bundle script — produces a single self-contained HTML file (dist/infinite-canvas.html)
 * that can be opened directly in a browser with no server required.
 *
 * Usage:  bun scripts/bundle.mjs
 *
 * What it does:
 *  1. Uses Bun's bundler to bundle all ES modules under src/ into one chunk.
 *  2. Reads styles.css and lib/jszip.min.js.
 *  3. Inlines everything into index.html, replacing external references.
 *  4. Writes the result to dist/infinite-canvas.html.
 */

import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

// 1. Bundle ES modules with Bun's bundler
const result = await Bun.build({
  entrypoints: [resolve(root, "src/script.js")],
  format: "esm",
  minify: {
    whitespace: true,
    syntax: true,
    identifiers: false,
  },
  target: "browser",
});

if (!result.success) {
  console.error("Build failed:");
  for (const msg of result.logs) console.error(msg);
  process.exit(1);
}

const bundledJS = await result.outputs[0].text();

// 2. Read static assets using Bun.file()
const stylesCSS = await Bun.file(resolve(root, "styles.css")).text();
const jszipJS = await Bun.file(resolve(root, "lib/jszip.min.js")).text();

// 3. Read and transform index.html
let html = await Bun.file(resolve(root, "index.html")).text();

// Replace the external stylesheet link with an inline <style> block
html = html.replace(
  /<link\s+rel="stylesheet"\s+href="styles\.css"\s*\/?>/,
  `<style>\n${stylesCSS}\n</style>`
);

// Replace the jszip <script> tag with an inline script
html = html.replace(
  /<script\s+src="lib\/jszip\.min\.js"\s*><\/script>/,
  `<script>\n${jszipJS}\n</script>`
);

// Replace the module script tag with the bundled code
html = html.replace(
  /<script\s+type="module"\s+src="\.\/src\/script\.js"\s*><\/script>/,
  `<script type="module">\n${bundledJS}\n</script>`
);

// 4. Write output
const outPath = resolve(root, "dist", "infinite-canvas.html");
await Bun.write(outPath, html);

console.log(`✓ Bundled to ${outPath}`);
