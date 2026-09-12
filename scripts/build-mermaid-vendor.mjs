/**
 * Bundle the mermaid engine into a self-contained ESM file at
 * plugins/mermaid/client/vendor/mermaid.bundle.mjs.
 *
 * Purpose: the mermaid renderer plugin ships its own engine, so copying the
 * plugin directory into <dataDir>/plugins/mermaid/ renders diagrams fully
 * offline (no CDN). When the vendor file is missing the plugin falls back to
 * the CDN (esm.sh) automatically.
 *
 * The bundle lives under client/ because the host's static file service only
 * exposes /plugins/:id/client/* (a deliberate security boundary): a module the
 * browser imports dynamically has to sit inside that subtree to be loadable.
 *
 * This file is a build artifact and is gitignored - `npm run build` produces it.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "plugins", "mermaid", "client", "vendor", "mermaid.bundle.mjs");
mkdirSync(dirname(OUT), { recursive: true });

const { errors } = await build({
	stdin: {
		// mermaid's default export means a browser that dynamically imports
		// ./vendor/mermaid.bundle.mjs gets the same `mermaid` object the npm
		// package provides (initialize/render all available).
		contents: 'import mermaid from "mermaid"; export default mermaid;',
		resolveDir: ROOT,
		sourcefile: "mermaid-vendor-entry.mjs",
	},
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2020",
	minify: true,
	logLevel: "info",
	outfile: OUT,
});

if (errors.length > 0) {
	console.error("x mermaid vendor bundle build failed");
	process.exit(1);
}
console.log("+ mermaid vendor bundle -> plugins/mermaid/client/vendor/mermaid.bundle.mjs");
