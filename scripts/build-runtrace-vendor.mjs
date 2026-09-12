/**
 * Copy the prebuilt vis-timeline distribution into plugins/run-trace/client/vendor/
 * so the run-trace timeline works offline.
 *
 * The standalone min.mjs build already contains Timeline and DataSet, so there is
 * nothing for esbuild to bundle here: the file is copied with a version banner and
 * the trimmed CSS is copied next to it.
 *
 * Copying the plugin directory into <dataDir>/plugins/run-trace/ then works fully
 * offline. If the vendor files are missing the client falls back to the esm.sh CDN,
 * and if that fails too it falls back to a plain div timeline, so the view never
 * renders blank.
 *
 * These files are build artifacts and are gitignored - `npm run build` produces them.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "plugins", "run-trace", "client", "vendor");
mkdirSync(VENDOR, { recursive: true });

const { version } = JSON.parse(readFileSync(join(ROOT, "node_modules", "vis-timeline", "package.json"), "utf8"));
const SRC_JS = join(ROOT, "node_modules", "vis-timeline", "standalone", "esm", "vis-timeline-graph2d.min.mjs");
const SRC_CSS = join(ROOT, "node_modules", "vis-timeline", "styles", "vis-timeline-graph2d.min.css");

const js = readFileSync(SRC_JS, "utf8");
writeFileSync(
	join(VENDOR, "vis-timeline.bundle.mjs"),
	`/** vis-timeline v${version} standalone (min) - run-trace vendor, offline-first. See scripts/build-runtrace-vendor.mjs. */\n${js}`,
);
copyFileSync(SRC_CSS, join(VENDOR, "vis-timeline.css"));
console.log(`+ run-trace vendor <- vis-timeline v${version}`);
