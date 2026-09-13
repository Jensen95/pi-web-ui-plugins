#!/usr/bin/env node
/**
 * Remove generated artifacts.
 *
 * Safety guard. An artifact whose src/*.ts does not exist yet cannot be rebuilt.
 * While plugins are still being ported from upstream, the hand-written .mjs
 * sitting at those exact paths is the porting agent's source material - and it is
 * gitignored, so deleting it is not recoverable from git. `npm run clean`
 * therefore removes only what the TypeScript sources can regenerate, and reports
 * what it refused. Pass --force to delete those too.
 *
 * Once every plugin is ported the guard never triggers and clean removes
 * everything, which is the behaviour CI and `npm run clean` users expect.
 *
 * Usage:
 *   node scripts/clean.mjs           # remove what is safely rebuildable
 *   node scripts/clean.mjs --force   # remove every artifact, rebuildable or not
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = join(ROOT, "plugins");
const force = process.argv.includes("--force");

/** Artifact path -> the TypeScript source that regenerates it. */
const ENTRIES = [
	{ artifact: "index.mjs", source: "src/index.ts" },
	{ artifact: "client/entry.mjs", source: "src/client.ts" },
];

const removed = [];
const refused = [];

const pluginDirs = existsSync(PLUGINS_DIR) ? readdirSync(PLUGINS_DIR).sort() : [];

for (const id of pluginDirs) {
	const dir = join(PLUGINS_DIR, id);

	for (const entry of ENTRIES) {
		const artifact = join(dir, entry.artifact);
		if (!existsSync(artifact)) continue;
		const rel = `plugins/${id}/${entry.artifact}`;
		if (!force && !existsSync(join(dir, entry.source))) {
			refused.push(`${rel} (no plugins/${id}/${entry.source} to rebuild it from)`);
			continue;
		}
		rmSync(artifact, { force: true });
		removed.push(rel);
	}

	// Vendor bundles are always rebuildable from npm dependencies alone.
	const vendor = join(dir, "client", "vendor");
	if (existsSync(vendor)) {
		rmSync(vendor, { recursive: true, force: true });
		removed.push(`plugins/${id}/client/vendor/`);
	}
}

const extensionDist = join(PLUGINS_DIR, "page-picker", "extension", "dist");
if (existsSync(extensionDist)) {
	rmSync(extensionDist, { recursive: true, force: true });
	removed.push("plugins/page-picker/extension/dist/");
}

for (const path of removed) console.log(`- removed ${path}`);
for (const path of refused) console.log(`! kept    ${path}`);
console.log(`\nclean: ${removed.length} removed, ${refused.length} kept`);

if (refused.length > 0) {
	console.error(
		`\nRefusing to delete artifacts that have no TypeScript source yet. Port the plugin first, or\n` +
			`re-run with: node scripts/clean.mjs --force`,
	);
	process.exit(1);
}
