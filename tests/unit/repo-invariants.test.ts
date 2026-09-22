/**
 * Cross-cutting repo invariants: the ones no single-plugin test can see, because
 * each of them relates two or more plugins, or a plugin to the repo around it.
 *
 *   - every manifest is loadable, English, and free of the two-field upstream
 *     description convention this repo dropped
 *   - the plugin directories and plugins/catalog.json agree exactly, in both
 *     directions, so the marketplace list cannot silently drift
 *   - permission strings use families the host actually recognises, and every
 *     gated host API a plugin calls has its family declared
 *   - the TypeScript layout and bootstrap/runtime artifact policy stay consistent, and
 *     every generated entry can be rebuilt from a committed source
 *   - the toolchain is really TypeScript 7
 *   - no plugin reaches outside its own directory, which is what makes
 *     "copy one directory" a complete install
 *
 * These are the definition of done for the repo as a whole. Keep the inventory and
 * install contract in sync when adding a plugin.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CJK_RE, findCjk, formatCjkHits, isGitIgnored, pluginIds, repoPath } from "../helpers/repo-files";

/** The fifteen plugins this repo ships, and the source entries each one must compile to. */
const EXPECTED_ARTIFACTS: Record<string, { server: boolean; client: boolean }> = {
	"catalog-sync": { server: false, client: true },
	"db-client": { server: true, client: true },
	"image-toolkit": { server: true, client: true },
	"jira-review": { server: true, client: true },
	"mcp-manager": { server: true, client: true },
	mermaid: { server: false, client: true },
	"run-trace": { server: true, client: true },
	"session-shadow": { server: true, client: true },
	"subagent-config": { server: true, client: true },
	"ui-shortcuts": { server: false, client: true },
	"vscode-editor": { server: true, client: true },
	webmail: { server: true, client: true },
	"topbar-fix": { server: false, client: true },
	"worktree-preparer": { server: true, client: true },
	"voice-input": { server: true, client: true },
};
const EXPECTED_IDS = Object.keys(EXPECTED_ARTIFACTS).sort();

/** Families the host gates in server/plugins.ts, via its can("<family>") calls.
 *  A missing or misspelled one of these is denied at runtime, silently but for a
 *  single console.error line. "ui" and "chat" were added in 0.86 (issue #146);
 *  without "ui" a manifest's whole `ui` block is dropped in strict mode. */
const ENFORCED_FAMILIES = ["chat", "fs", "http", "tools", "ui"];

/** Families upstream manifests declare that the host does not gate. They are
 *  surfaced verbatim in Settings (SettingsModal.tsx renders permissions.join(", ")),
 *  so they document intent to the user rather than unlocking an API. */
const DECLARATIVE_FAMILIES = ["net", "terminal"];

const DOCUMENTED_FAMILIES = [...ENFORCED_FAMILIES, ...DECLARATIVE_FAMILIES];

/** Which enforced family a piece of plugin source needs, keyed by the host API
 *  that triggers the gate. Deliberately one-directional: declaring a family a
 *  plugin does not use is harmless (the host only ever denies), so only
 *  usage-without-declaration is a defect. Patterns that do not match (a method
 *  passed as a variable, a destructured host) under-report, never over-report. */
const ENFORCED_USAGE: { family: string; pattern: RegExp }[] = [
	{ family: "tools", pattern: /\bregisterAgentTool\s*\(/ },
	{ family: "http", pattern: /\.route\s*\(\s*["'](GET|POST|PUT|DELETE|get|post|put|delete)["']/ },
	{ family: "fs", pattern: /\.fs\s*\.\s*(list|read|readText|write|remove)\s*\(/ },
];

interface Manifest {
	id?: string;
	name?: string;
	description?: string;
	descriptionEn?: string;
	permissions?: unknown;
	[key: string]: unknown;
}

interface CatalogEntry {
	id: string;
	name?: string;
	icon?: string;
	description?: string;
	source?: string;
	homepage?: string;
	[key: string]: unknown;
}

// --- readers (all lazy: the tree is being edited while this suite runs) ---

function gitFilesCached(): string[] {
	const out = execFileSync("git", ["ls-files", "--cached", "-z"], {
		cwd: repoPath(),
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return out
		.split("\0")
		.filter(Boolean)
		.map((file) => file.split("\\").join("/"));
}

function readJsonFile<T>(rel: string): T {
	return JSON.parse(readFileSync(repoPath(rel), "utf8")) as T;
}

function manifestRel(id: string): string {
	return `plugins/${id}/manifest.json`;
}

function readManifest(id: string): Manifest {
	return readJsonFile<Manifest>(manifestRel(id));
}

function readCatalog(): CatalogEntry[] {
	return readJsonFile<CatalogEntry[]>("plugins/catalog.json");
}

/** Every file on disk under a directory, repo-relative with forward slashes. */
function filesUnder(rel: string): string[] {
	const absolute = repoPath(rel);
	if (!existsSync(absolute)) return [];
	const found: string[] = [];
	const step = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.name === "node_modules" || entry.name === "storage") continue;
			if (entry.isDirectory()) step(full);
			else if (entry.isFile()) found.push(relative(repoPath(), full).split("\\").join("/"));
		}
	};
	step(absolute);
	return found.sort();
}

/** TypeScript sources of one plugin, repo-relative. */
function pluginSources(id: string): string[] {
	return filesUnder(`plugins/${id}/src`).filter((file) => file.endsWith(".ts"));
}

/** Collect every key in a JSON value, at any depth, so a nested descriptionEn
 *  (inside settings schemas, for example) cannot slip through. */
function allKeys(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(allKeys);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.keys(record).flatMap((key) => [key, ...allKeys(record[key])]);
	}
	return [];
}

/** Import/export/require specifiers in a source file, skipping `//` comments so a
 *  path mentioned in prose is not mistaken for a dependency. */
function importSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	for (const line of source.split("\n")) {
		const commentAt = line.search(/(^|[^:])\/\//);
		const code = commentAt === -1 ? line : line.slice(0, line.indexOf("//", commentAt));
		for (const match of code.matchAll(/\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
			specifiers.push(match[1]!);
		}
	}
	return specifiers;
}

const NODE_BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith("_")));

function isNodeBuiltin(specifier: string): boolean {
	return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.split("/")[0]!);
}

describe("plugin manifests", () => {
	it("exist for exactly the thirteen plugins this repo ships", () => {
		expect(pluginIds(), "plugin directories under plugins/ must match the ported set").toEqual(EXPECTED_IDS);
		for (const id of EXPECTED_IDS) {
			expect(existsSync(repoPath(manifestRel(id))), `${manifestRel(id)} is missing`).toBe(true);
		}
	});

	it("all parse as JSON objects", () => {
		const problems: string[] = [];
		for (const id of pluginIds()) {
			try {
				const manifest = readManifest(id);
				if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
					problems.push(`${id}: manifest.json is not a JSON object`);
				}
			} catch (err) {
				problems.push(`${id}: manifest.json does not parse (${String(err)})`);
			}
		}
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("all carry a non-empty name and description", () => {
		const problems: string[] = [];
		for (const id of pluginIds()) {
			const manifest = readManifest(id);
			for (const key of ["name", "description"] as const) {
				const value = manifest[key];
				if (typeof value !== "string" || value.trim() === "") problems.push(`${id}: manifest has no ${key}`);
			}
		}
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("carry no descriptionEn key: this repo is English-only, so description holds English", () => {
		// The host picks `locale !== "zh" && descriptionEn ? descriptionEn : description`.
		// Keeping both fields would leave Chinese in "description" and hide it from
		// every English reader, which is exactly what the port removes.
		const problems: string[] = [];
		for (const id of pluginIds()) {
			const keys = allKeys(readManifest(id));
			if (keys.includes("descriptionEn")) problems.push(`${id}: manifest.json still has descriptionEn`);
			if (readFileSync(repoPath(manifestRel(id)), "utf8").includes("descriptionEn")) {
				problems.push(`${id}: manifest.json text mentions descriptionEn`);
			}
		}
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("contain zero CJK characters", () => {
		const offenders = pluginIds().flatMap((id) => formatCjkHits(manifestRel(id), findCjk(manifestRel(id), CJK_RE), 10));
		expect(offenders, `CJK characters found:\n${offenders.join("\n")}`).toEqual([]);
	});

	it("use an id that matches their directory name when they declare one", () => {
		// The host defaults the id to the directory name, and installs to
		// <dataDir>/plugins/<id>, so a mismatch means two identities for one plugin.
		const problems = pluginIds()
			.map((id) => ({ id, declared: readManifest(id).id }))
			.filter(({ id, declared }) => declared !== undefined && declared !== id)
			.map(({ id, declared }) => `${id}: manifest id is "${String(declared)}"`);
		expect(problems, problems.join("\n")).toEqual([]);
	});
});

describe("catalog and plugin directories agree", () => {
	it("list the same ids in both directions", () => {
		const catalogIds = readCatalog().map((entry) => entry.id);
		const dirs = pluginIds();
		const missingFromCatalog = dirs.filter((id) => !catalogIds.includes(id));
		const missingFromDisk = catalogIds.filter((id) => !dirs.includes(id));
		expect(missingFromCatalog, `plugin dirs absent from catalog.json: ${missingFromCatalog.join(", ")}`).toEqual([]);
		expect(missingFromDisk, `catalog.json entries with no plugin dir: ${missingFromDisk.join(", ")}`).toEqual([]);
		expect(catalogIds.length, "catalog has duplicate ids").toBe(new Set(catalogIds).size);
	});

	it("reference no upstream owner, and point every homepage at this repo", () => {
		const problems: string[] = [];
		for (const entry of readCatalog()) {
			const blob = JSON.stringify(entry);
			if (blob.includes("xing-shuyin") || blob.includes("xingshuyin")) {
				problems.push(`${entry.id}: entry still references the upstream owner`);
			}
			const homepage = entry.homepage ?? "";
			let url: URL | undefined;
			try {
				url = new URL(homepage);
			} catch {
				problems.push(`${entry.id}: homepage "${homepage}" is not a URL`);
			}
			if (url) {
				if (url.hostname !== "github.com") problems.push(`${entry.id}: homepage host is ${url.hostname}`);
				if (!url.pathname.startsWith("/Jensen95/pi-web-ui-plugins/")) {
					problems.push(`${entry.id}: homepage path ${url.pathname} is not in this repo`);
				}
				if (!url.pathname.endsWith(`/plugins/${entry.id}`)) {
					problems.push(`${entry.id}: homepage does not point at its own plugin directory`);
				}
			}
		}
		expect(problems, problems.join("\n")).toEqual([]);
	});
});

describe("manifest permissions", () => {
	it("use only permission families the host recognises", () => {
		const problems: string[] = [];
		for (const id of pluginIds()) {
			const declared = readManifest(id).permissions;
			if (declared === undefined) continue;
			if (!Array.isArray(declared)) {
				problems.push(`${id}: permissions must be an array`);
				continue;
			}
			for (const permission of declared) {
				if (typeof permission !== "string" || permission.trim() === "") {
					problems.push(`${id}: permissions contains a non-string entry`);
					continue;
				}
				// server/plugins.ts: permFamilies = new Set(declared.map(x => x.split(":")[0]))
				const family = permission.split(":")[0]!;
				if (!DOCUMENTED_FAMILIES.includes(family)) {
					problems.push(
						`${id}: "${permission}" has family "${family}", expected one of ${DOCUMENTED_FAMILIES.join(", ")}`,
					);
				}
			}
		}
		expect(problems, `misspelled families are denied at runtime:\n${problems.join("\n")}`).toEqual([]);
	});

	it("declare the enforced family for every gated host API their sources call", () => {
		const problems: string[] = [];
		for (const id of pluginIds()) {
			const manifest = readManifest(id);
			const declared = manifest.permissions;
			// No permissions array means legacy full-access mode: the host allows
			// everything and warns once, so there is nothing to under-declare.
			if (!Array.isArray(declared) || declared.length === 0) continue;
			const families = new Set(declared.filter((p): p is string => typeof p === "string").map((p) => p.split(":")[0]!));
			const source = pluginSources(id)
				.map((file) => readFileSync(repoPath(file), "utf8"))
				.join("\n");
			for (const { family, pattern } of ENFORCED_USAGE) {
				if (pattern.test(source) && !families.has(family)) {
					problems.push(`plugins/${id}: sources call a "${family}"-gated host API but permissions omit "${family}"`);
				}
			}
		}
		expect(problems, `the host denies these silently at runtime:\n${problems.join("\n")}`).toEqual([]);
	});
});

describe("TypeScript layout", () => {
	it("gives every plugin a src/ directory of TypeScript sources", () => {
		const problems = pluginIds()
			.map((id) => ({ id, sources: pluginSources(id) }))
			.filter(({ sources }) => sources.length === 0)
			.map(({ id }) => `plugins/${id}/src has no .ts file`);
		expect(problems, `not ported to TypeScript yet:\n${problems.join("\n")}`).toEqual([]);
	});

	it("leaves no hand-written upstream JavaScript outside image-toolkit runtime assets", () => {
		const strays = filesUnder("plugins").filter(
			(file) =>
				(file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) &&
				// Compiled output lives at these exact paths and is checked separately.
				!/^plugins\/[^/]+\/index\.mjs$/.test(file) &&
				!/^plugins\/[^/]+\/client\/entry\.mjs$/.test(file) &&
				!/^plugins\/[^/]+\/client\/vendor\//.test(file) &&
				!/^plugins\/image-toolkit\/(core\/|client\/(?!entry\.mjs$))/.test(file) &&
				!file.startsWith("plugins/page-picker/extension/"),
		);
		expect(strays, `delete these; src/*.ts replaced them:\n${strays.join("\n")}`).toEqual([]);
	});

	it("leaves no obsolete per-plugin build.mjs, package.json or package-lock.json", () => {
		const obsolete = filesUnder("plugins").filter((file) => {
			const depth = file.split("/");
			// plugins/<id>/<name> only - plugins/catalog.json is a repo file, not a plugin file.
			return depth.length === 3 && ["build.mjs", "package.json", "package-lock.json"].includes(depth[2]!);
		});
		expect(obsolete, `dependencies live in the root package.json:\n${obsolete.join("\n")}`).toEqual([]);
	});

	it("commits no build output: every plugin is installed from source with --build", () => {
		const generated = gitFilesCached().filter((file) =>
			/^plugins\/[^/]+\/(?:index\.mjs|client\/entry\.mjs|client\/vendor\/)/.test(file),
		);
		expect(generated, `build output must not be committed:\n${generated.join("\n")}`).toEqual([]);
	});
});

describe("compiled artifacts", () => {
	it("keeps every compiled entry out of the committed payload", () => {
		const generated = gitFilesCached().filter((file) =>
			/^plugins\/[^/]+\/(?:index\.mjs|client\/entry\.mjs|client\/vendor\/)/.test(file),
		);
		expect(generated, `compiled output must be ignored:\n${generated.join("\n")}`).toEqual([]);
	});

	it("are regenerable from committed sources alone", () => {
		// A fresh CI runner clones the repo and runs `npm run build`. If any source an
		// artifact is built from is itself ignored, that build cannot reproduce the
		// artifact and the release archive ships something unbuildable.
		const problems: string[] = [];
		const check = (source: string, artifact: string): void => {
			if (!existsSync(repoPath(artifact))) return;
			if (!existsSync(repoPath(source))) {
				problems.push(`${artifact} exists but its source ${source} does not`);
				return;
			}
			if (isGitIgnored(source)) {
				problems.push(`${source} is gitignored, so ${artifact} cannot be rebuilt from a clone`);
			}
		};
		for (const id of pluginIds()) {
			check(`plugins/${id}/src/index.ts`, `plugins/${id}/index.mjs`);
			check(`plugins/${id}/src/client.ts`, `plugins/${id}/client/entry.mjs`);
		}
		// Vendor bundles come from the shared scripts, not from plugin sources.
		for (const vendor of filesUnder("plugins").filter((file) => file.includes("/client/vendor/"))) {
			const pluginId = vendor.split("/")[1]!;
			const script = `scripts/build-${pluginId.replace(/-/g, "")}-vendor.mjs`;
			if (!existsSync(repoPath(script))) {
				problems.push(`${vendor} has no committed vendor build script (looked for ${script})`);
			} else if (isGitIgnored(script)) {
				problems.push(`${script} is gitignored, so ${vendor} cannot be rebuilt from a clone`);
			}
		}
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("keep every committed source, manifest and README trackable", () => {
		// catalog.json is the host's built-in marketplace list; if it were ignored it
		// would vanish from every clone and release without anything failing first.
		const mustNotBeIgnored = [
			"plugins/catalog.json",
			...pluginIds().flatMap((id) => [...pluginSources(id), manifestRel(id), `plugins/${id}/README.md`]),
		];
		expect(mustNotBeIgnored.length).toBeGreaterThan(0);
		const ignored = mustNotBeIgnored.filter((file) => existsSync(repoPath(file)) && isGitIgnored(file));
		expect(ignored, `sources must never be ignored:\n${ignored.join("\n")}`).toEqual([]);
		const missingReadme = pluginIds().filter((id) => !existsSync(repoPath(`plugins/${id}/README.md`)));
		expect(missingReadme, `plugins without a README: ${missingReadme.join(", ")}`).toEqual([]);
	});
});

describe("toolchain", () => {
	it("really runs TypeScript 7, with no TS5 able to shadow it", () => {
		const installed = readJsonFile<{ version: string }>("node_modules/typescript/package.json");
		expect(installed.version, "typescript must be 7.x or `npm run typecheck` means something else").toMatch(/^7\./);
		// The CLI the typecheck script invokes must resolve to that same package.
		expect(realpathSync(repoPath("node_modules/.bin/tsc"))).toBe(
			realpathSync(repoPath("node_modules/typescript/bin/tsc")),
		);
		// A nested copy under another dependency would win for that dependency's own
		// type resolution, so none may exist.
		const nested = readdirSync(repoPath("node_modules"))
			.filter((name) => !name.startsWith("."))
			.filter((name) => {
				const inner = repoPath("node_modules", name, "node_modules", "typescript");
				return existsSync(inner) && statSync(inner).isDirectory();
			});
		expect(nested, `nested typescript copies can shadow the root one: ${nested.join(", ")}`).toEqual([]);
	});
});

describe("plugin self-containment", () => {
	it("never imports a path outside its own plugin directory", () => {
		// Installing a plugin means copying one directory. A relative import that
		// escapes it, or an absolute path into this checkout, produces a plugin that
		// only works here.
		const problems: string[] = [];
		for (const id of pluginIds()) {
			const root = resolve(repoPath(`plugins/${id}`));
			for (const file of pluginSources(id)) {
				const source = readFileSync(repoPath(file), "utf8");
				for (const specifier of importSpecifiers(source)) {
					if (isNodeBuiltin(specifier)) continue;
					if (isAbsolute(specifier)) {
						problems.push(`${file}: absolute import "${specifier}"`);
						continue;
					}
					if (!specifier.startsWith(".")) continue; // a bare npm specifier, bundled or auto-installed
					const target = resolve(dirname(repoPath(file)), specifier);
					const escaped = relative(root, target);
					if (escaped.startsWith("..") || isAbsolute(escaped)) {
						problems.push(`${file}: "${specifier}" resolves outside plugins/${id}/`);
					}
				}
			}
		}
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("scans real sources, so the check above is not vacuous", () => {
		const sources = pluginIds().flatMap(pluginSources);
		expect(sources.length, "no plugin sources found to scan").toBeGreaterThan(0);
		const specifierCount = sources.reduce(
			(total, file) => total + importSpecifiers(readFileSync(repoPath(file), "utf8")).length,
			0,
		);
		expect(specifierCount, "no import specifiers found; the scanner is not matching anything").toBeGreaterThan(0);
	});
});

describe("licence and attribution", () => {
	it("keeps the root licence MIT", () => {
		const licence = readFileSync(repoPath("LICENSE"), "utf8");
		expect(licence).toMatch(/MIT License/);
		expect(licence).toMatch(/Permission is hereby granted, free of charge/);
	});

	it("credits the upstream project in the README, as MIT requires", () => {
		const readme = readFileSync(repoPath("README.md"), "utf8");
		expect(readme, "README must have an Acknowledgements section").toMatch(/^#+\s*Acknowledgements/m);
		expect(readme, "README must link the upstream repository").toContain("https://github.com/xing-shuyin/pi-web-ui");
		expect(readme, "README must state these are derivative works").toMatch(/derivative/i);
		expect(readme, "README must carry the upstream copyright notice").toMatch(/xingshuyin/i);
	});

	it("states the direct GitHub install story in the README", () => {
		const readme = readFileSync(repoPath("README.md"), "utf8");
		expect(readme).toContain("pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/catalog-sync --build");
		expect(readme).toMatch(/source-only/i);
		expect(readme, "README must state the minimum host version").toContain("0.86");
		expect(readme).toMatch(/release workflow/i);
		expect(readme).toMatch(/English-only/i);
	});
});
