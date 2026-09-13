import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildZip, readZip } from "./zip.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const outDir = join(repoRoot, "release");

const REQUIRED = ["manifest.json", "options.html"];

const REQUIRED_DIST = ["background.js", "picker.js", "bind.js", "bridge.js", "options.js"];

function collect(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) collect(full, out);
		else out.push(full);
	}
	return out;
}

function main() {
	let distFiles = [];
	try {
		distFiles = collect(join(here, "dist")).filter((f) => !f.endsWith(".map"));
	} catch {
		console.error("✗ dist/ is missing -- run npm run build:extension first");
		process.exit(1);
	}
	const entryFiles = REQUIRED.map((n) => join(here, n));
	const missing = REQUIRED.filter((n) => !existsSync(join(here, n)));
	if (missing.length > 0) {
		console.error(`✗ Missing files: ${missing.join(", ")}`);
		process.exit(1);
	}
	if (distFiles.length === 0) {
		console.error("✗ dist/ is empty -- run npm run build:extension first");
		process.exit(1);
	}
	const missingDist = REQUIRED_DIST.filter(
		(name) => !distFiles.some((f) => f.endsWith(join("dist", name)) || f.endsWith(`dist/${name}`)),
	);
	if (missingDist.length > 0) {
		console.error(`✗ dist/ is missing ${missingDist.join(", ")} -- run npm run build:extension`);
		process.exit(1);
	}

	let manifest;
	try {
		manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
	} catch (error) {
		console.error(`✗ Cannot read manifest.json: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	const version = manifest.version ?? "0.0.0";

	const entries = [...entryFiles, ...distFiles]
		.map((full) => ({
			name: relative(here, full).split("\\").join("/"),
			data: new Uint8Array(readFileSync(full)),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	const zip = buildZip(entries);

	const info = readZip(zip);
	const names = info.entries.map((e) => e.name);
	if (names.length !== entries.length) {
		console.error(`✗ Self-check failed: wrote ${entries.length} entries but read back ${names.length}`);
		process.exit(1);
	}
	if (!names.includes("manifest.json")) {
		console.error("✗ Self-check failed: manifest.json is not at the zip root; Chrome will reject it");
		process.exit(1);
	}

	mkdirSync(outDir, { recursive: true });
	const versioned = join(outDir, `page-picker-extension-${version}.zip`);
	writeFileSync(versioned, zip);

	const alias = join(outDir, "page-picker-extension.zip");
	writeFileSync(alias, zip);

	const kb = (zip.length / 1024).toFixed(1);
	const rel = (f) => relative(repoRoot, f).split("\\").join("/");
	console.log(`✓ ${rel(versioned)}  (${entries.length} files, ${kb} KB)`);
	console.log(`  ${rel(alias)}  (same content; use the stable link)`);
	for (const e of info.entries) console.log(`    ${e.name}  (${e.size} B)`);
	console.log('  Extract the directory and load it with "Load unpacked" in Chrome');
}

main();
