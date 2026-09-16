/**
 * Unit tests for the vscode-editor client view: plugins/vscode-editor/src/client.ts.
 *
 * What is covered here, and why:
 *   - the view contract the frontend loader requires (a default export with mount),
 *   - every pure helper the client exports: HTML/shell escaping, base64 helpers,
 *     language and icon lookup, fuzzy matching, wire path/key handling, the two
 *     modal payload builders, the SSH home-directory probe parser and the xterm
 *     palette fallbacks,
 *   - the English-only invariant for the files this unit owns.
 *
 * What is NOT covered, honestly: mount() itself. It writes a large innerHTML
 * template, constructs a CodeMirror EditorView and an xterm Terminal, and reads
 * window/document/getComputedStyle/CSS.escape. None of that exists in vitest's
 * "node" environment, and jsdom is not a dependency of this repo (and installing
 * one is out of scope for this port). Exercising mount() would need a real
 * browser, so it is asserted at the contract level and in the compiled-artifact
 * smoke test (vscode-editor-client-build.test.ts) instead of being faked here.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	THEME_CHANGE_EVENT,
	b64,
	bufToB64,
	buildTermTheme,
	closestFromEventTarget,
	esc,
	fuzzyScore,
	homeFromPwdOutput,
	hostPayloadFrom,
	iconFor,
	isLightTheme,
	langFor,
	langName,
	localParentOf,
	parentOf,
	parseExcludeList,
	parseTk,
	shQuote,
	syncPayloadFrom,
	tkey,
} from "../../plugins/vscode-editor/src/client.ts";
import clientView from "../../plugins/vscode-editor/src/client.ts";
import type { HostFormValues, SyncFormValues } from "../../plugins/vscode-editor/src/client-types.ts";
import { CJK_RE, findCjk, formatCjkHits, repoPath } from "../helpers/repo-files";

/** Files this unit owns. The compiled client bundle is scanned by the build smoke test. */
const OWNED_FILES = [
	"plugins/vscode-editor/src/client.ts",
	"plugins/vscode-editor/src/client-types.ts",
	"tests/unit/vscode-editor-client.test.ts",
	"tests/unit/vscode-editor-client-build.test.ts",
];

describe("vscode-editor client: English-only sources", () => {
	it("has no CJK characters in any file this unit owns", () => {
		const offending: string[] = [];
		for (const rel of OWNED_FILES) {
			expect(existsSync(repoPath(rel)), `${rel} is missing`).toBe(true);
			for (const hit of findCjk(rel, CJK_RE)) offending.push(...formatCjkHits(rel, [hit], 1));
		}
		expect(offending).toEqual([]);
	});

	it("replaced the upstream hand-written client.js instead of sitting next to it", () => {
		// A leftover src/client.js would never be built (the builder only reads
		// src/client.ts) and would keep the Chinese source alive in the repo.
		expect(existsSync(repoPath("plugins/vscode-editor/src/client.js"))).toBe(false);
		expect(existsSync(repoPath("plugins/vscode-editor/src/client.ts"))).toBe(true);
	});

	it("really contains the translated UI text, so the scan above is not vacuous", () => {
		const text = readFileSync(repoPath("plugins/vscode-editor/src/client.ts"), "utf8");
		expect(text).toContain("Local Workspace");
		expect(text).toContain("SSH Hosts");
		expect(text).toContain("Upload the current file automatically on save");
		// The view is one large mount() over a fixed DOM template; a stub that
		// merely exports the helpers would pass the assertions above.
		expect(text.split("\n").length).toBeGreaterThan(1500);
	});
});

describe("vscode-editor client: view contract", () => {
	it("default-exports a view with mount and nothing else", () => {
		expect(Object.keys(clientView)).toEqual(["mount"]);
		expect(typeof clientView.mount).toBe("function");
	});

	it("ignores a click target that is not an element", () => {
		// Browser events may originate from a non-Element EventTarget; the toolbar
		// must ignore it rather than attempting target.closest() and throwing.
		expect(closestFromEventTarget(new EventTarget(), "button[data-act]")).toBeNull();
	});
});

describe("vscode-editor client: theme plumbing", () => {
	it("listens for the exact event name the main app dispatches", () => {
		// Renaming this silently breaks light/dark following; it is a cross-repo
		// contract with web/src/theme.ts, not prose.
		expect(THEME_CHANGE_EVENT).toBe("pi-web-ui:theme-change");
	});

	it("treats a missing DOM as the dark default", () => {
		// No document in this environment, so the getComputedStyle probe must fail
		// closed to dark rather than throw.
		expect(isLightTheme()).toBe(false);
	});

	it("falls back to the full xterm palette when no CSS variables are available", () => {
		const theme = buildTermTheme();
		expect(Object.keys(theme)).toEqual([
			"background",
			"foreground",
			"cursor",
			"cursorAccent",
			"selectionBackground",
			"black",
			"red",
			"green",
			"yellow",
			"blue",
			"magenta",
			"cyan",
			"white",
			"brightBlack",
			"brightRed",
			"brightGreen",
			"brightYellow",
			"brightBlue",
			"brightMagenta",
			"brightCyan",
			"brightWhite",
		]);
		expect(theme.background).toBe("#0b0d12");
		expect(theme.cursor).toBe("#8b5cf6");
		expect(theme.selectionBackground).toBe("rgba(139, 92, 246, 0.35)");
		expect(theme.brightWhite).toBe("#ffffff");
	});
});

describe("vscode-editor client: esc()", () => {
	it("escapes every character that can break out of an attribute or text node", () => {
		expect(esc(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
	});

	it("escapes repeatedly occurring characters, not just the first", () => {
		expect(esc("&&<<>>")).toBe("&amp;&amp;&lt;&lt;&gt;&gt;");
	});

	it("coerces nullish and non-string input to an empty string", () => {
		expect(esc(undefined)).toBe("");
		expect(esc(null)).toBe("");
		expect(esc(0)).toBe("0");
	});

	it("leaves English smart quotes alone (they are not markup)", () => {
		expect(esc("‘quoted’")).toBe("‘quoted’");
	});
});

describe("vscode-editor client: shQuote()", () => {
	it("wraps a path in single quotes", () => {
		expect(shQuote("/var/www/app")).toBe("'/var/www/app'");
	});

	it("escapes embedded single quotes so a remote shell cannot be broken out of", () => {
		expect(shQuote("/tmp/it's here")).toBe(`'/tmp/it'\\''s here'`);
		expect(shQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
	});

	it("treats nullish input as an empty argument", () => {
		expect(shQuote(undefined)).toBe("''");
		expect(shQuote(null)).toBe("''");
	});
});

describe("vscode-editor client: base64 helpers", () => {
	it("round-trips unicode terminal text through enc()/bytes()", () => {
		const text = "naïve café ✓ $PATH\n";
		expect(new TextDecoder().decode(b64.bytes(b64.enc(text)))).toBe(text);
	});

	it("encodes to the same base64 the server's Buffer produces", () => {
		expect(b64.enc("hello")).toBe(Buffer.from("hello", "utf8").toString("base64"));
	});

	it("decodes a known payload byte for byte", () => {
		expect([...b64.bytes("AAEC/w==")]).toEqual([0, 1, 2, 255]);
	});

	it("bufToB64 matches Buffer for an empty array", () => {
		expect(bufToB64(new Uint8Array(0))).toBe("");
	});

	it("bufToB64 matches Buffer for bytes that are not valid latin1 text", () => {
		const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7 + 200) % 256);
		expect(bufToB64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
	});

	it("bufToB64 keeps every byte across its internal batching boundary", () => {
		// The helper builds the latin1 string in 0x8000-byte batches; a batch that
		// drops or duplicates bytes only shows up past that boundary.
		const size = 0x8000 * 2 + 1234;
		const bytes = new Uint8Array(size);
		for (let i = 0; i < size; i++) bytes[i] = i % 251;
		expect(bufToB64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
	});
});

describe("vscode-editor client: language detection", () => {
	it("names every supported language", () => {
		const cases: [string, string][] = [
			["a.ts", "TypeScript"],
			["a.tsx", "TypeScript"],
			["a.js", "JavaScript"],
			["a.jsx", "JavaScript"],
			["a.mjs", "JavaScript"],
			["a.cjs", "JavaScript"],
			["a.json", "JSON"],
			["a.json5", "JSON"],
			["a.css", "CSS"],
			["a.html", "HTML"],
			["a.htm", "HTML"],
			["a.vue", "HTML"],
			["a.svelte", "HTML"],
			["a.md", "Markdown"],
			["a.markdown", "Markdown"],
			["a.py", "Python"],
		];
		for (const [path, label] of cases) expect(langName(path), path).toBe(label);
	});

	it("falls back to Plain Text for anything else", () => {
		expect(langName("Makefile")).toBe("Plain Text");
		expect(langName("a.rs")).toBe("Plain Text");
		expect(langName("")).toBe("Plain Text");
	});

	it("labels by the last extension only", () => {
		expect(langName("archive.tar.gz")).toBe("Plain Text");
		expect(langName("component.test.ts")).toBe("TypeScript");
	});

	it("is case sensitive, unlike langFor() which lowercases first", () => {
		// Pinned on purpose: the status bar label and the syntax highlighting use
		// two different lookup rules upstream, and a port that "harmonises" them
		// silently changes one of the two.
		expect(langName("A.TS")).toBe("Plain Text");
		expect(langFor("A.TS")).not.toBeNull();
	});

	it("builds an extension for known languages and null for unknown ones", () => {
		expect(langFor("a.py")).not.toBeNull();
		expect(langFor("a.unknownext")).toBeNull();
		expect(langFor("")).toBeNull();
	});
});

describe("vscode-editor client: iconFor()", () => {
	it("always gives a directory the folder icon, whatever its name", () => {
		expect(iconFor("src", "dir")).toBe("📁");
		expect(iconFor("weird.js", "dir")).toBe("📁");
	});

	it("maps known extensions", () => {
		expect(iconFor("a.ts", "file")).toBe("🟦");
		expect(iconFor("a.js", "file")).toBe("🟨");
		expect(iconFor("a.py", "file")).toBe("🐍");
		expect(iconFor("a.md", "file")).toBe("📝");
		expect(iconFor("a.png", "file")).toBe("🖼");
		expect(iconFor("a.lock", "file")).toBe("🔒");
		expect(iconFor("a.yaml", "file")).toBe("⚙️");
	});

	it("falls back to a plain document icon", () => {
		expect(iconFor("a.rs", "file")).toBe("📄");
		expect(iconFor("Makefile", "file")).toBe("📄");
		expect(iconFor("", "file")).toBe("📄");
		expect(iconFor("a.tar.gz", "file")).toBe("📄");
	});

	it("ignores extension case", () => {
		expect(iconFor("A.JS", "file")).toBe("🟨");
	});
});

describe("vscode-editor client: fuzzyScore()", () => {
	it("returns -1 when the query is not a subsequence of the target", () => {
		expect(fuzzyScore("xyz", "abc")).toBe(-1);
		expect(fuzzyScore("ac", "ca")).toBe(-1);
		expect(fuzzyScore("abcd", "abc")).toBe(-1);
	});

	it("matches case-insensitively", () => {
		expect(fuzzyScore("ABC", "abc")).toBe(fuzzyScore("abc", "ABC"));
		expect(fuzzyScore("abc", "ABC")).toBeGreaterThan(0);
	});

	it("scores an empty query as the length bonus alone", () => {
		expect(fuzzyScore("", "abc")).toBeCloseTo(3.7);
		expect(fuzzyScore("", "")).toBe(4);
	});

	it("prefers contiguous hits over scattered ones", () => {
		expect(fuzzyScore("abc", "abc")).toBeGreaterThan(fuzzyScore("abc", "axbxc"));
	});

	it("prefers short file names", () => {
		expect(fuzzyScore("ab", "ab")).toBeGreaterThan(fuzzyScore("ab", "ab-something-much-longer"));
	});

	it("requires every query character in order", () => {
		expect(fuzzyScore("mt", "main.ts")).toBeGreaterThan(0);
		expect(fuzzyScore("tm", "main.ts")).toBe(-1);
	});
});

describe("vscode-editor client: tab keys and wire paths", () => {
	it("joins scope and path with a single colon", () => {
		expect(tkey("local", "src/a.ts")).toBe("local:src/a.ts");
		expect(tkey("c1", "/home/u/x")).toBe("c1:/home/u/x");
		expect(tkey("local", "")).toBe("local:");
	});

	it("splits a key at the first colon only, so paths may contain colons", () => {
		expect(parseTk("c1:dir/a:b.ts")).toEqual({ scope: "c1", path: "dir/a:b.ts" });
		expect(parseTk("local:")).toEqual({ scope: "local", path: "" });
	});

	it("round-trips through tkey/parseTk", () => {
		for (const [scope, path] of [
			["local", "a/b.ts"],
			["c1", "/srv/app/x:y.js"],
			["local", ""],
		] as [string, string][]) {
			expect(parseTk(tkey(scope, path))).toEqual({ scope, path });
		}
	});

	it("resolves a remote parent directory", () => {
		expect(parentOf("/a/b/c")).toBe("/a/b");
		expect(parentOf("/a/b/")).toBe("/a");
		expect(parentOf("a/b")).toBe("a");
		expect(parentOf("/a")).toBe("/");
		expect(parentOf("a")).toBe("/");
	});

	it("clamps a remote parent at the filesystem root", () => {
		expect(parentOf("/")).toBe("/");
		expect(parentOf("")).toBe("/");
		expect(parentOf(".")).toBe("/");
		expect(parentOf("//")).toBe("/");
	});

	it("resolves a local parent directory as workspace-relative", () => {
		expect(localParentOf("a/b.js")).toBe("a");
		expect(localParentOf("/a/b.js")).toBe("/a");
	});

	it("returns an empty string for a root-level local file, unlike parentOf", () => {
		expect(localParentOf("a.js")).toBe("");
		expect(localParentOf("/a.js")).toBe("");
		expect(localParentOf("")).toBe("");
		expect(parentOf("a.js")).toBe("/");
	});
});

describe("vscode-editor client: homeFromPwdOutput()", () => {
	it("takes the last line of a pwd run as the remote home", () => {
		expect(homeFromPwdOutput("/home/dev\n")).toBe("/home/dev");
		expect(homeFromPwdOutput("/home/dev")).toBe("/home/dev");
		expect(homeFromPwdOutput("motd banner\r\n/home/dev\r\n")).toBe("/home/dev");
	});

	it("trims surrounding whitespace before validating", () => {
		expect(homeFromPwdOutput("  /root  \n")).toBe("/root");
	});

	it("rejects output that is not an absolute path", () => {
		expect(homeFromPwdOutput("relative/dir")).toBeNull();
		expect(homeFromPwdOutput("")).toBeNull();
		expect(homeFromPwdOutput("   \n")).toBeNull();
		expect(homeFromPwdOutput(undefined)).toBeNull();
	});

	it("rejects a failed run whose output is only blank lines", () => {
		expect(homeFromPwdOutput("\n\n")).toBeNull();
	});
});

describe("vscode-editor client: modal payload builders", () => {
	const hostValues = (over: Partial<HostFormValues> = {}): HostFormValues => ({
		name: " my-server ",
		host: " 10.0.0.5 ",
		port: "2222",
		username: " deploy ",
		password: "s3cret",
		privateKey: "  ",
		passphrase: "",
		privateKeyPath: "  ",
		agent: "  ",
		...over,
	});

	it("trims text fields and keeps the port numeric", () => {
		expect(hostPayloadFrom(hostValues())).toEqual({
			name: "my-server",
			host: "10.0.0.5",
			port: 2222,
			username: "deploy",
			password: "s3cret",
			privateKey: undefined,
			passphrase: undefined,
			privateKeyPath: "",
			agent: "",
		});
	});

	it("passes a key path and agent through trimmed, and a passphrase verbatim", () => {
		const p = hostPayloadFrom(
			hostValues({ privateKeyPath: " ~/.ssh/id_ed25519 ", agent: " $SSH_AUTH_SOCK ", passphrase: " pw " }),
		);
		expect(p.privateKeyPath).toBe("~/.ssh/id_ed25519");
		expect(p.agent).toBe("$SSH_AUTH_SOCK");
		expect(p.passphrase).toBe(" pw ");
	});

	it("never sends an id - the caller attaches it only when editing", () => {
		expect("id" in hostPayloadFrom(hostValues())).toBe(false);
	});

	it("falls back to port 22 and username root", () => {
		expect(hostPayloadFrom(hostValues({ port: "not-a-number" })).port).toBe(22);
		expect(hostPayloadFrom(hostValues({ port: "" })).port).toBe(22);
		expect(hostPayloadFrom(hostValues({ port: "0" })).port).toBe(22);
		expect(hostPayloadFrom(hostValues({ username: "   " })).username).toBe("root");
	});

	it("omits blank secrets so the server keeps the stored credential", () => {
		expect(hostPayloadFrom(hostValues({ password: "" })).password).toBeUndefined();
		expect(hostPayloadFrom(hostValues({ privateKey: "\n\t " })).privateKey).toBeUndefined();
	});

	it("does not trim the password, so a deliberate space is preserved", () => {
		expect(hostPayloadFrom(hostValues({ password: " " })).password).toBe(" ");
	});

	const syncValues = (over: Partial<SyncFormValues> = {}): SyncFormValues => ({
		name: "prod",
		host: "example.com",
		port: "22",
		username: "root",
		password: "",
		privateKey: "",
		privateKeyPath: " ~/.ssh/id_rsa ",
		agent: " $SSH_AUTH_SOCK ",
		remoteRoot: " /var/www/app ",
		exclude: "node_modules/**, dist, *.log",
		uploadOnSave: true,
		...over,
	});

	it("builds the sync payload with trimmed strings and parsed excludes", () => {
		expect(syncPayloadFrom(syncValues())).toEqual({
			name: "prod",
			host: "example.com",
			port: 22,
			username: "root",
			password: undefined,
			privateKey: undefined,
			privateKeyPath: "~/.ssh/id_rsa",
			agent: "$SSH_AUTH_SOCK",
			remoteRoot: "/var/www/app",
			exclude: ["node_modules/**", "dist", "*.log"],
			uploadOnSave: true,
		});
	});

	it("passes uploadOnSave through untouched", () => {
		expect(syncPayloadFrom(syncValues({ uploadOnSave: false })).uploadOnSave).toBe(false);
	});

	it("keeps privateKeyPath and agent as strings even when blank", () => {
		const payload = syncPayloadFrom(syncValues({ privateKeyPath: "  ", agent: "" }));
		expect(payload.privateKeyPath).toBe("");
		expect(payload.agent).toBe("");
	});

	it("parses a comma separated exclude list, dropping blanks", () => {
		expect(parseExcludeList("a, b ,c")).toEqual(["a", "b", "c"]);
		expect(parseExcludeList(",, ,")).toEqual([]);
		expect(parseExcludeList("")).toEqual([]);
		expect(parseExcludeList("single")).toEqual(["single"]);
		expect(parseExcludeList("node_modules/**")).toEqual(["node_modules/**"]);
	});
});
