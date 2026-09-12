/**
 * The mermaid fence-renderer plugin: manifest contract, client entry shape, the
 * pure helpers that decide how a diagram is themed and sized, the English-only
 * invariant for this plugin's files, and the compiled artifact.
 *
 * mermaid is a renderer-only plugin (manifest "view": false, "renderers":
 * ["mermaid"]): there is no server entry, so nothing here calls activate(host).
 *
 * The DOM glue that cannot run under vitest's "node" environment (creating the
 * off-screen holder, awaiting mermaid.render, the theme-change listener) is
 * covered upstream by a real browser E2E; here it is stubbed only where the
 * plugin's own decision logic lives. See the notes in each describe.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPlugin } from "../helpers/plugin-build";
import { importClientArtifact, isClientEntry, loadPlugin } from "../helpers/plugin-contract";
import { cjkPatternFor, findCjk, formatCjkHits, repoPath } from "../helpers/repo-files";

const PLUGIN_ID = "mermaid";
const PLUGIN_DIR = repoPath("plugins", PLUGIN_ID);
const CLIENT_SOURCE = `plugins/${PLUGIN_ID}/src/client.ts`;

/**
 * Built once for this file: the shared builder also regenerates the 3.4 MB
 * vendor bundle for this plugin, so a second run would only waste seconds.
 * buildPlugin captures failures instead of throwing, so a broken build shows up
 * as an assertion rather than a crashed suite.
 */
const build = buildPlugin(PLUGIN_ID);

/** The plugin's client module, loaded lazily so a missing source file fails the
 *  individual tests instead of aborting the whole file at collection time. */
async function clientModule(): Promise<typeof import("../../plugins/mermaid/src/client.ts")> {
	return import("../../plugins/mermaid/src/client.ts");
}

/** `file:line:col: text` for every CJK character in one path. */
function offendersIn(relPath: string): string[] {
	return formatCjkHits(relPath, findCjk(relPath, cjkPatternFor(relPath)), 25);
}

/** Every path under plugins/mermaid except the generated vendor bundle. */
function pluginFilePaths(): string[] {
	const found: string[] = [];
	const step = (dir: string, rel: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const childRel = `${rel}/${entry.name}`;
			if (entry.isDirectory()) {
				if (childRel === `plugins/${PLUGIN_ID}/client/vendor`) continue;
				step(join(dir, entry.name), childRel);
			} else {
				found.push(childRel);
			}
		}
	};
	step(PLUGIN_DIR, `plugins/${PLUGIN_ID}`);
	return found.sort();
}

/**
 * Minimal stand-in for the two platform APIs the theme helpers read: the root
 * element's computed color-scheme and CSS custom properties, and the body's
 * background color. Each value is only served for the element the plugin is
 * documented to read it from, so reading the wrong element fails the test.
 */
function stubComputedStyle(options: {
	colorScheme?: string;
	backgroundColor?: string;
	/** Value returned per custom property name; anything else reads as "". */
	vars?: (name: string) => string;
}): void {
	const documentElement = { tag: "html" };
	const body = { tag: "body" };
	vi.stubGlobal("document", { documentElement, body });
	vi.stubGlobal("getComputedStyle", (element: unknown) => ({
		colorScheme: element === documentElement ? (options.colorScheme ?? "") : "",
		backgroundColor: element === body ? (options.backgroundColor ?? "") : "",
		getPropertyValue: (name: string) => (element === documentElement ? (options.vars?.(name) ?? "") : ""),
	}));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("mermaid manifest", () => {
	const plugin = loadPlugin(PLUGIN_ID);
	const { manifest, raw } = plugin;

	it("parses and keeps the id and version upstream shipped", () => {
		expect(plugin.id).toBe(PLUGIN_ID);
		expect(raw.id).toBe(PLUGIN_ID);
		expect(manifest.version).toBe("1.0.0");
	});

	it("is named and described in English", () => {
		expect(manifest.name).toBe("Mermaid Diagrams");
		const description = manifest.description ?? "";
		expect(description.length).toBeGreaterThan(20);
		expect(offendersIn(`plugins/${PLUGIN_ID}/manifest.json`)).toEqual([]);
		// Meaningful, not a placeholder: it has to say what the plugin renders.
		for (const word of ["mermaid", "SVG", "renderer"]) {
			expect(description.toLowerCase(), `description does not mention "${word}"`).toContain(word.toLowerCase());
		}
	});

	it("carries no descriptionEn key: this repo puts English in description", () => {
		expect(raw).not.toHaveProperty("descriptionEn");
	});

	it("keeps the lazy-loading flags the host reads, exactly", () => {
		// view:false + renderers:["mermaid"] are what make the frontend load this
		// bundle only when a ```mermaid fence actually appears.
		expect(manifest.view).toBe(false);
		expect(manifest.renderers).toEqual(["mermaid"]);
		expect(raw.view).toBe(false);
		expect(raw.renderers).toEqual(["mermaid"]);
	});

	it("declares no permissions, matching upstream", () => {
		expect(raw).not.toHaveProperty("permissions");
	});
});

describe("mermaid plugin layout", () => {
	it("authors the client in TypeScript and ships no upstream JavaScript", () => {
		expect(existsSync(repoPath(CLIENT_SOURCE)), `${CLIENT_SOURCE} is missing`).toBe(true);
		// Upstream's per-plugin build script and package manifest are obsolete: one
		// shared builder and the root package.json cover this plugin.
		for (const obsolete of ["build.mjs", "package.json", "package-lock.json"]) {
			expect(existsSync(join(PLUGIN_DIR, obsolete)), `plugins/mermaid/${obsolete} must be deleted`).toBe(false);
		}
		// A renderer plugin has no server logic, so the builder must not find an
		// entry to compile and the host must not find an index.mjs to activate.
		expect(existsSync(join(PLUGIN_DIR, "src", "index.ts"))).toBe(false);
		expect(existsSync(join(PLUGIN_DIR, "index.mjs")), "a renderer plugin has no server entry").toBe(false);
	});

	it("keeps src/ free of compiled or non-TypeScript files", () => {
		const sources = readdirSync(join(PLUGIN_DIR, "src"));
		expect(sources.length).toBeGreaterThan(0);
		expect(
			sources.filter((name) => !name.endsWith(".ts")),
			"plugins/mermaid/src holds TypeScript sources only",
		).toEqual([]);
	});

	it("has no stray hand-written .mjs outside the two generated artifact paths", () => {
		const stray = pluginFilePaths().filter(
			(rel) =>
				(rel.endsWith(".mjs") || rel.endsWith(".js")) &&
				rel !== `plugins/${PLUGIN_ID}/client/entry.mjs` &&
				!rel.includes("/client/vendor/"),
		);
		expect(stray, "generated artifacts only, never hand-written JavaScript").toEqual([]);
	});
});

describe("mermaid client entry contract", () => {
	it("exports exactly a renderers map, the shape the fence loader requires", async () => {
		const mod = await clientModule();
		expect(Object.keys(mod.default)).toEqual(["renderers"]);
		expect(Object.keys(mod.default.renderers)).toEqual(["mermaid"]);
		expect(typeof mod.default.renderers.mermaid).toBe("function");
		// Renderer plugins are not views: the frontend never calls mount() on them.
		expect(mod.default).not.toHaveProperty("mount");
	});

	it("provides a renderer for every language the manifest claims", async () => {
		const { manifest } = loadPlugin(PLUGIN_ID);
		const mod = await clientModule();
		const declared = manifest.renderers ?? [];
		expect(declared).not.toEqual([]);
		for (const lang of declared) {
			// The host logs an error and falls back to a plain code block when a
			// claimed language has no renderer, so this cross-check is the contract.
			expect(typeof mod.default.renderers[lang], `no renderer for "${lang}"`).toBe("function");
		}
	});

	it("returns a promise from the renderer without throwing synchronously", async () => {
		const mod = await clientModule();
		const ctx = { pluginId: PLUGIN_ID, send: () => {}, onData: () => () => {} };
		// The renderer is async, so any failure reaches the host as a rejection it
		// turns into the plain-code-block fallback instead of an escaped throw.
		const pending: unknown[] = [];
		expect(() => {
			for (const code of ["graph TD; A-->B", "", "this is not mermaid at all"]) {
				pending.push(mod.default.renderers.mermaid(code, ctx));
			}
			// A partial ctx must not be dereferenced either.
			pending.push(mod.default.renderers.mermaid("graph TD", { pluginId: PLUGIN_ID } as typeof ctx));
		}).not.toThrow();
		expect(pending).toHaveLength(4);
		for (const result of pending) {
			expect(result).toBeInstanceOf(Promise);
			// No mermaid engine is reachable from a node test run, so the render cannot
			// complete; swallow it to keep the failure out of the unhandled-rejection log.
			await (result as Promise<unknown>).catch(() => undefined);
		}
	});
});

describe("preserveSvgWidth", () => {
	async function preserve(svg: string): Promise<string> {
		return (await clientModule()).preserveSvgWidth(svg);
	}

	it("gives the root SVG a concrete width and lifts the max-width cap", async () => {
		const out = await preserve('<svg viewBox="0 0 800 600" width="100%" style="max-width: 600px;" id="x"><g/></svg>');
		expect(out).toContain('width="800"');
		expect(out).toContain('style="max-width:none"');
		// The percentage width and the cap are what made wide diagrams shrink.
		expect(out).not.toContain('width="100%"');
		expect(out).not.toContain("max-width: 600px");
		// Untouched attributes and content survive.
		expect(out).toContain('viewBox="0 0 800 600"');
		expect(out).toContain('id="x"');
		expect(out).toContain("<g/>");
	});

	it("keeps unrelated inline styles alongside the added cap", async () => {
		const out = await preserve('<svg viewBox="0 0 100 50" style="background:red; width:10px">x</svg>');
		expect(out).toContain("background:red; max-width:none");
		expect(out).not.toContain("width:10px");
		expect(out).toContain('width="100"');
	});

	it("reads comma-separated, single-quoted, uppercase and fractional viewBoxes", async () => {
		expect(await preserve("<svg viewBox='0,0,640,480'>x</svg>")).toContain('width="640"');
		expect(await preserve('<SVG VIEWBOX="0 0 10 10">x</SVG>')).toContain('width="10"');
		expect(await preserve('<svg viewBox="0 0 800.5 600">x</svg>')).toContain('width="800.5"');
	});

	it("returns the input unchanged when there is nothing to size", async () => {
		const unchanged = [
			"",
			"<div>not svg</div>",
			'<svg width="100%">no viewBox</svg>',
			'<svg viewBox="0 0 800">x</svg>',
			'<svg viewBox="0 0 abc def">x</svg>',
			'<svg viewBox="0 0 0 0">x</svg>',
			'<svg viewBox="0 0 -20 10">x</svg>',
		];
		for (const svg of unchanged) {
			expect(await preserve(svg), `expected unchanged: ${JSON.stringify(svg)}`).toBe(svg);
		}
	});

	it("is idempotent, so a theme re-render cannot compound the rewrite", async () => {
		const once = await preserve('<svg viewBox="0 0 300 200" width="100%" style="max-width:300px">x</svg>');
		expect(await preserve(once)).toBe(once);
	});
});

describe("isDarkAppearance", () => {
	async function isDark(colorScheme: string, backgroundColor: string): Promise<boolean> {
		return (await clientModule()).isDarkAppearance(colorScheme, () => backgroundColor);
	}

	it("honours an explicit color-scheme before looking at any color", async () => {
		expect(await isDark("dark", "rgb(255, 255, 255)")).toBe(true);
		expect(await isDark("light", "rgb(0, 0, 0)")).toBe(false);
		// "dark light" is what browsers report when a page supports both; upstream
		// checks dark first, so dark wins whichever order the tokens arrive in.
		expect(await isDark("dark light", "rgb(255, 255, 255)")).toBe(true);
		expect(await isDark("light dark", "rgb(0, 0, 0)")).toBe(true);
	});

	it("falls back to background luminance for legacy themes", async () => {
		expect(await isDark("normal", "rgb(255, 255, 255)")).toBe(false);
		expect(await isDark("", "rgb(20, 22, 28)")).toBe(true);
		// An unrecognized scheme (matching is case sensitive) also uses luminance.
		expect(await isDark("Dark", "rgb(255, 255, 255)")).toBe(false);
		expect(await isDark("Dark", "rgb(0, 0, 0)")).toBe(true);
	});

	it("applies the luminance threshold and ignores alpha", async () => {
		// 0.299r + 0.587g + 0.114b < 128 is dark.
		expect(await isDark("normal", "rgb(126, 126, 126)")).toBe(true);
		expect(await isDark("normal", "rgb(129, 129, 129)")).toBe(false);
		// Only the first three components are read, so a transparent white stays light.
		expect(await isDark("normal", "rgba(255, 255, 255, 0)")).toBe(false);
		expect(await isDark("normal", "rgba(10, 20, 30, 0.5)")).toBe(true);
	});

	it("treats an unparseable background as dark, the bundled default theme", async () => {
		expect(await isDark("normal", "transparent")).toBe(true);
		expect(await isDark("normal", "")).toBe(true);
		expect(await isDark("normal", "rgb(10, 20)")).toBe(true);
	});
});

describe("parseFontSize", () => {
	async function parse(raw: string): Promise<number> {
		return (await clientModule()).parseFontSize(raw);
	}

	it("accepts a positive size and ignores the unit", async () => {
		expect(await parse("12px")).toBe(12);
		expect(await parse("16.5px")).toBe(16.5);
		expect(await parse("  14px")).toBe(14);
		expect(await parse("1000")).toBe(1000);
	});

	it("falls back to 12px for anything unusable", async () => {
		for (const raw of ["", "   ", "abc", "px", "0px", "0", "-4px", "NaN"]) {
			expect(await parse(raw), `expected the fallback for ${JSON.stringify(raw)}`).toBe(12);
		}
	});
});

describe("themeVariables", () => {
	it("reads the host CSS variables for both palettes", async () => {
		stubComputedStyle({ vars: (name) => `VALUE(${name})` });
		const { themeVariables } = await clientModule();
		const dark = themeVariables(true, 14);
		const light = themeVariables(false, 14);

		// Dark and light read the same variables from different slots; a swapped
		// mapping would render light text on a light background.
		expect(dark.background).toBe("VALUE(--bg-elev2)");
		expect(dark.primaryColor).toBe("VALUE(--bg-elev)");
		expect(dark.textColor).toBe("VALUE(--text)");
		expect(dark.labelBackground).toBe("VALUE(--bg)");
		expect(light.background).toBe("VALUE(--bg)");
		expect(light.primaryColor).toBe("VALUE(--bg-elev2)");
		expect(light.textColor).toBe("VALUE(--text)");
		for (const vars of [dark, light]) {
			expect(vars.primaryBorderColor).toBe("VALUE(--border)");
			expect(vars.lineColor).toBe("VALUE(--text-dim)");
			expect(vars.nodeBorder).toBe("VALUE(--accent)");
			expect(vars.fontFamily).toBe("VALUE(--mono)");
			expect(vars.fontSize).toBe("14px");
		}
	});

	it("uses the bundled palette and a monospace fallback when variables are unset", async () => {
		stubComputedStyle({ vars: () => "   " });
		const { themeVariables } = await clientModule();
		const dark = themeVariables(true, 12);
		const light = themeVariables(false, 12);

		expect(dark.background).toBe("#1a1d26");
		expect(dark.primaryColor).toBe("#14161c");
		expect(dark.primaryBorderColor).toBe("#262a35");
		expect(dark.lineColor).toBe("#9aa1b4");
		expect(dark.textColor).toBe("#e6e8ef");
		expect(dark.nodeBorder).toBe("#8b5cf6");
		expect(dark.labelBackground).toBe("#0d0e12");
		expect(light.background).toBe("#ffffff");
		expect(light.primaryColor).toBe("#f6f8fa");
		expect(light.primaryBorderColor).toBe("#d0d7de");
		expect(light.lineColor).toBe("#59636e");
		expect(light.textColor).toBe("#1f2328");
		expect(light.nodeBorder).toBe("#0969da");
		expect(light.labelBackground).toBe("#ffffff");
		for (const vars of [dark, light]) {
			expect(vars.fontFamily).toBe("monospace");
			expect(vars.fontSize).toBe("12px");
		}
	});

	it("trims the computed value and ignores the body element", async () => {
		stubComputedStyle({ vars: (name) => (name === "--text" ? "  #abc  " : ""), backgroundColor: "rgb(0, 0, 0)" });
		const { themeVariables } = await clientModule();
		expect(themeVariables(false, 12).textColor).toBe("#abc");
	});
});

describe("isDarkTheme", () => {
	it("reads color-scheme from the root element and the background from the body", async () => {
		const { isDarkTheme } = await clientModule();
		stubComputedStyle({ colorScheme: "dark" });
		expect(isDarkTheme()).toBe(true);
		stubComputedStyle({ colorScheme: "light" });
		expect(isDarkTheme()).toBe(false);
		// Neither element supplies a usable value: the dark default applies.
		stubComputedStyle({});
		expect(isDarkTheme()).toBe(true);
		stubComputedStyle({ colorScheme: "normal", backgroundColor: "rgb(255, 255, 255)" });
		expect(isDarkTheme()).toBe(false);
		stubComputedStyle({ colorScheme: "normal", backgroundColor: "rgb(13, 14, 18)" });
		expect(isDarkTheme()).toBe(true);
	});

	it("sizes diagrams from the --mermaid-font-size variable", async () => {
		const { diagramFontSize } = await clientModule();
		stubComputedStyle({ vars: (name) => (name === "--mermaid-font-size" ? "18px" : "") });
		expect(diagramFontSize()).toBe(18);
		stubComputedStyle({ vars: () => "" });
		expect(diagramFontSize()).toBe(12);
		stubComputedStyle({ vars: () => "nonsense" });
		expect(diagramFontSize()).toBe(12);
	});
});

describe("mermaid English-only invariant", () => {
	it("scans a real, non-empty set of this plugin's files", () => {
		const files = pluginFilePaths();
		for (const required of [
			`plugins/${PLUGIN_ID}/manifest.json`,
			`plugins/${PLUGIN_ID}/README.md`,
			CLIENT_SOURCE,
			`plugins/${PLUGIN_ID}/client/entry.mjs`,
		]) {
			expect(files, `${required} was not scanned`).toContain(required);
			expect(statSync(repoPath(required)).size, `${required} is too small to be real`).toBeGreaterThan(200);
		}
		// The generated vendor bundle is third-party output and is excluded.
		expect(files.some((file) => file.includes("/client/vendor/"))).toBe(false);
	});

	it("has zero CJK characters in every file this plugin owns", () => {
		const offenders = [...pluginFilePaths(), "tests/unit/mermaid.test.ts"].flatMap(offendersIn);
		expect(offenders, `CJK characters found (translate them):\n${offenders.join("\n")}`).toEqual([]);
	});
});

describe("mermaid build", () => {
	it("builds the client entry and no server entry", () => {
		expect(build.status, `build failed:\n${build.stderr}\n${build.stdout}`).toBe(0);
		expect(build.ok).toBe(true);
		expect(build.clientEntry, "client/entry.mjs was not produced").toBeDefined();
		expect(build.serverEntry, "a renderer plugin must not produce index.mjs").toBeUndefined();
		expect(build.artifacts).toEqual([`plugins/${PLUGIN_ID}/client/entry.mjs`]);
		// The builder reports "+ <id>:" for what it compiled and "- <id>: ... skipped"
		// for a plugin with no sources; mermaid must be in the first group.
		expect(build.stdout).toMatch(new RegExp(`^\\+ ${PLUGIN_ID}: `, "m"));
		expect(build.stdout).not.toMatch(new RegExp(`^- ${PLUGIN_ID}:`, "m"));
	});

	it("compiles an artifact that is provably generated from the TypeScript source", () => {
		const artifact = readFileSync(repoPath(`plugins/${PLUGIN_ID}/client/entry.mjs`), "utf8");
		// The banner is what distinguishes a build output from upstream's hand-written
		// entry.mjs left behind at the same gitignored path.
		expect(artifact).toContain("Generated by scripts/build-plugins.mjs");
		expect(artifact).toContain(CLIENT_SOURCE);
		expect(offendersIn(`plugins/${PLUGIN_ID}/client/entry.mjs`)).toEqual([]);
	});

	it("keeps the vendor engine loadable from the served client/ subtree", () => {
		const artifact = readFileSync(repoPath(`plugins/${PLUGIN_ID}/client/entry.mjs`), "utf8");
		// The browser resolves this relative to client/entry.mjs; esbuild must leave
		// the external specifier alone or every diagram silently falls back to the CDN.
		expect(artifact).toContain("./vendor/mermaid.bundle.mjs");
		expect(artifact).not.toContain("../src/");
		// The CDN fallback is a URL import, which a browser can load.
		expect(artifact).toContain("https://esm.sh/mermaid@11");
	});

	it("bundles the client with no bare npm specifier", () => {
		const artifact = readFileSync(repoPath(`plugins/${PLUGIN_ID}/client/entry.mjs`), "utf8");
		const bareStatic = /(?:^|[\s;}])(?:import|export)[^;\n]*?from\s*["'](?!\.|\/|https?:)[^"']+["']/m;
		const bareDynamic = /import\(\s*["'](?!\.|\/|https?:)[^"']+["']\s*\)/m;
		expect(bareStatic.test(artifact), "client bundle has a bare static npm import").toBe(false);
		expect(bareDynamic.test(artifact), "client bundle has a bare dynamic npm import").toBe(false);
	});

	it("imports as valid ESM exporting the renderer the host looks up", async () => {
		expect(existsSync(repoPath(`plugins/${PLUGIN_ID}/client/entry.mjs`))).toBe(true);
		const mod = await importClientArtifact(PLUGIN_ID);
		expect(isClientEntry(mod), "compiled entry.mjs is not a client entry").toBe(true);
		const entry = (mod as { default: { renderers?: Record<string, unknown> } }).default;
		expect(typeof entry.renderers?.mermaid).toBe("function");
		expect(entry).not.toHaveProperty("mount");
	});
});
