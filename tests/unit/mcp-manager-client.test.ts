/**
 * The pure helpers the mcp-manager view uses to turn form text into a config
 * entry. They are exported from src/client.ts so they can be tested under the
 * node environment; mount() itself needs a DOM and is covered by the build
 * smoke test in mcp-manager-plugin.test.ts.
 */
import { describe, expect, it } from "vitest";
import view, { parseArgsText, parseEnvText, summarizeEntry } from "../../plugins/mcp-manager/src/client.ts";

describe("view entry shape", () => {
	it("exports a mount function the frontend loader requires", () => {
		expect(typeof view.mount).toBe("function");
	});
});

describe("parseArgsText", () => {
	it("takes one argument per line and keeps inner spaces", () => {
		expect(parseArgsText("-y\nsome mcp\n--dir /tmp/a b")).toEqual(["-y", "some mcp", "--dir /tmp/a b"]);
	});

	it("trims surrounding whitespace and drops blank lines", () => {
		expect(parseArgsText("  -y  \n\n   \n--flag\n")).toEqual(["-y", "--flag"]);
	});

	it("returns no arguments for empty input", () => {
		expect(parseArgsText("")).toEqual([]);
		expect(parseArgsText("   \n\t\n")).toEqual([]);
	});

	it("keeps an argument that looks like a flag or a number", () => {
		expect(parseArgsText("--\n-1\n0")).toEqual(["--", "-1", "0"]);
	});
});

describe("parseEnvText", () => {
	it("parses KEY=VALUE lines", () => {
		expect(parseEnvText("API_KEY=abc\nOTHER=1")).toEqual({ env: { API_KEY: "abc", OTHER: "1" }, rejected: [] });
	});

	it("keeps everything after the first equals sign, including empty values", () => {
		expect(parseEnvText("TOKEN=\nURL=https://x.example/mcp?a=b")).toEqual({
			env: { TOKEN: "", URL: "https://x.example/mcp?a=b" },
			rejected: [],
		});
	});

	it("reports lines it cannot parse instead of dropping them silently", () => {
		expect(parseEnvText("GOOD=1\nno-value-here\n=missing-key\n  \nALSO_GOOD=2")).toEqual({
			env: { GOOD: "1", ALSO_GOOD: "2" },
			rejected: ["no-value-here", "=missing-key"],
		});
	});

	it("trims the key and blank lines away", () => {
		expect(parseEnvText("\n  SPACED_KEY = value \n")).toEqual({ env: { SPACED_KEY: "value" }, rejected: [] });
	});

	it("returns an empty map for empty input", () => {
		expect(parseEnvText("")).toEqual({ env: {}, rejected: [] });
	});

	it("lets a later line win when a key repeats", () => {
		expect(parseEnvText("K=first\nK=second")).toEqual({ env: { K: "second" }, rejected: [] });
	});
});

describe("summarizeEntry", () => {
	it("shows a stdio server as its command line", () => {
		expect(summarizeEntry({ command: "npx", args: ["-y", "some-mcp"] })).toBe("npx -y some-mcp");
	});

	it("shows a command with no arguments on its own", () => {
		expect(summarizeEntry({ command: "svc-mcp" })).toBe("svc-mcp");
		expect(summarizeEntry({ command: "svc-mcp", args: [] })).toBe("svc-mcp");
	});

	it("shows a remote server as its url", () => {
		expect(summarizeEntry({ url: "https://svc.example/mcp" })).toBe("https://svc.example/mcp");
	});

	it("prefers the url when a merged entry somehow carries both", () => {
		expect(summarizeEntry({ command: "svc", url: "https://svc.example/mcp" })).toBe("https://svc.example/mcp");
	});

	it("says so when there is nothing runnable to show", () => {
		expect(summarizeEntry({})).toBe("(no command or url)");
		expect(summarizeEntry({ env: { A: "1" } })).toBe("(no command or url)");
	});
});
