/**
 * run-trace pure helpers: the trace-math module both entries depend on.
 *
 * These functions decide what the timeline says - how long a text block looks
 * like it took, which tool arguments yield file paths, and what a tool segment
 * is titled - so they are the highest-value target of the JS -> TS port. Every
 * branch upstream had is pinned here: the clamps, the dedupe and cap, the length
 * filters, the malformed-JSON catch, the non-object JSON, the bash fallthrough.
 *
 * The constants are asserted verbatim on purpose: a regex character class or a
 * truncation cap that drifts by one silently changes what the trace shows, and
 * nothing else in the suite would notice.
 */
import { describe, expect, it } from "vitest";
import {
	DETAIL_CAP,
	MAX_CONVS,
	PATH_KEYS,
	POLL_IDLE_MS,
	POLL_STREAMING_MS,
	PREVIEW_CAP,
	READONLY_TOOL_RE,
	REFRESH_DEBOUNCE_MS,
	SUMMARY_CAP,
	WRITE_TOOL_RE,
	blockText,
	cut,
	estTextMs,
	extractPaths,
	firstLine,
	toolHeadline,
} from "../../plugins/run-trace/src/trace";
import type { ContentBlock } from "../../plugins/run-trace/src/trace";

/** The marker cut() appends when it truncates. */
const TRUNCATED = "\n… [truncated]";

describe("trace limits and classifiers", () => {
	it("keeps the truncation, retention, debounce and poll constants exact", () => {
		expect(SUMMARY_CAP).toBe(300);
		expect(DETAIL_CAP).toBe(8000);
		expect(PREVIEW_CAP).toBe(4000);
		expect(MAX_CONVS).toBe(10);
		expect(REFRESH_DEBOUNCE_MS).toBe(300);
		expect(POLL_STREAMING_MS).toBe(5000);
		expect(POLL_IDLE_MS).toBe(30000);
	});

	it("keeps the write-tool classifier verbatim and behaving", () => {
		expect(WRITE_TOOL_RE.source).toBe("edit|write|patch|apply|create|save|move|rename|delete|remove|mkdir");
		expect(WRITE_TOOL_RE.flags).toBe("i");
		for (const name of [
			"edit",
			"multiEdit",
			"write_file",
			"patch",
			"apply",
			"create",
			"save",
			"move",
			"rename",
			"delete",
			"remove",
			"mkdir",
		]) {
			expect(WRITE_TOOL_RE.test(name), `${name} must count as a write`).toBe(true);
		}
		for (const name of ["read", "bash", "grep", "list", "search"]) {
			expect(WRITE_TOOL_RE.test(name), `${name} must not count as a write`).toBe(false);
		}
	});

	it("keeps the read-only classifier anchored at the start of the name", () => {
		expect(READONLY_TOOL_RE.source).toBe("^(read|get|list|glob|grep|search|show|cat|fetch|query)");
		expect(READONLY_TOOL_RE.flags).toBe("i");
		for (const name of [
			"read",
			"readFile",
			"get",
			"list",
			"glob",
			"grep",
			"search",
			"show",
			"cat",
			"fetch",
			"query",
			"READ",
		]) {
			expect(READONLY_TOOL_RE.test(name), `${name} must count as read-only`).toBe(true);
		}
		// Unanchored this would also match "edit_readme" and "bash_grep".
		for (const name of ["edit", "bash", "write", "do_read", "my-grep"]) {
			expect(READONLY_TOOL_RE.test(name), `${name} must not count as read-only`).toBe(false);
		}
	});

	it("keeps the path-key whitelist exact", () => {
		expect([...PATH_KEYS].sort()).toEqual(
			["cwd", "dir", "file", "fileName", "filepath", "filePath", "filename", "files", "path", "paths"].sort(),
		);
	});
});

describe("cut", () => {
	it("leaves short text alone", () => {
		expect(cut("abc", 5)).toBe("abc");
		expect(cut("abcde", 5)).toBe("abcde");
	});

	it("truncates at the cap and marks the cut", () => {
		const out = cut("abcdefgh", 3);
		expect(out).toBe(`abc${TRUNCATED}`);
		expect(out.length).toBe(3 + TRUNCATED.length);
	});

	it("coerces nullish and non-string input to a string", () => {
		expect(cut(undefined, 10)).toBe("");
		expect(cut(null, 10)).toBe("");
		expect(cut(42, 10)).toBe("42");
	});
});

describe("firstLine", () => {
	it("takes the first line, trimmed", () => {
		expect(firstLine("ls -la\nsecond\nthird")).toBe("ls -la");
		expect(firstLine("  padded  \nrest")).toBe("padded");
	});

	it("caps at 100 characters by default and marks the cut", () => {
		expect(firstLine("x".repeat(120))).toBe(`${"x".repeat(100)}…`);
		expect(firstLine("x".repeat(100))).toBe("x".repeat(100));
	});

	it("honours an explicit cap", () => {
		expect(firstLine("abcdefgh", 3)).toBe("abc…");
	});

	it("survives nullish and empty input", () => {
		expect(firstLine(undefined)).toBe("");
		expect(firstLine(null)).toBe("");
		expect(firstLine("")).toBe("");
		expect(firstLine("\nsecond")).toBe("");
	});
});

describe("estTextMs", () => {
	it("estimates 20ms per character", () => {
		expect(estTextMs(100)).toBe(2000);
		expect(estTextMs(1)).toBe(800); // 20ms would be invisible, so the floor wins
		expect(estTextMs(41.6)).toBe(832);
	});

	it("clamps to the 800ms floor", () => {
		expect(estTextMs(0)).toBe(800);
		expect(estTextMs(10)).toBe(800);
		expect(estTextMs(39)).toBe(800);
		expect(estTextMs(40)).toBe(800); // exactly at the floor
	});

	it("clamps to the 120000ms ceiling", () => {
		expect(estTextMs(6000)).toBe(120000); // exactly at the ceiling
		expect(estTextMs(6001)).toBe(120000);
		expect(estTextMs(10_000_000)).toBe(120000);
	});

	it("treats nullish, negative and non-numeric input as zero characters", () => {
		expect(estTextMs(undefined)).toBe(800);
		expect(estTextMs(null)).toBe(800);
		expect(estTextMs(Number.NaN)).toBe(800);
		expect(estTextMs(-500)).toBe(800);
		expect(estTextMs("not a number")).toBe(800);
	});

	it("coerces a numeric string", () => {
		expect(estTextMs("100")).toBe(2000);
	});
});

describe("extractPaths", () => {
	it("reads whitelisted keys one object level deep", () => {
		expect(extractPaths(JSON.stringify({ path: "src/a.ts" }))).toEqual(["src/a.ts"]);
		expect(extractPaths(JSON.stringify({ file: "notes.md" }))).toEqual(["notes.md"]);
		expect(extractPaths(JSON.stringify({ filePath: "a/b", cwd: "/tmp/x" }))).toEqual(["a/b", "/tmp/x"]);
	});

	it("ignores keys outside the whitelist", () => {
		expect(extractPaths(JSON.stringify({ command: "cat /etc/hosts", query: "a/b" }))).toEqual([]);
	});

	it("reads one array level under a whitelisted key", () => {
		expect(extractPaths(JSON.stringify({ paths: ["a/b.ts", "c/d.ts"] }))).toEqual(["a/b.ts", "c/d.ts"]);
		expect(extractPaths(JSON.stringify({ files: [1, null, "x/y", {}] }))).toEqual(["x/y"]);
	});

	it("does not descend into nested objects", () => {
		expect(extractPaths(JSON.stringify({ path: { file: "a/b.ts" } }))).toEqual([]);
	});

	it("requires a slash, backslash or dot in the value", () => {
		expect(extractPaths(JSON.stringify({ path: "plain" }))).toEqual([]);
		expect(extractPaths(JSON.stringify({ path: "C:\\dir\\f.txt" }))).toEqual(["C:\\dir\\f.txt"]);
		expect(extractPaths(JSON.stringify({ path: "a.b" }))).toEqual(["a.b"]);
	});

	it("drops empty, whitespace-only and over-long values", () => {
		expect(extractPaths(JSON.stringify({ path: "" }))).toEqual([]);
		expect(extractPaths(JSON.stringify({ path: "    " }))).toEqual([]);
		expect(extractPaths(JSON.stringify({ path: "a".repeat(301) }))).toEqual([]);
		// Exactly 300 characters is still accepted; 301 is not.
		const longest = `${"a".repeat(298)}/b`;
		expect(longest.length).toBe(300);
		expect(extractPaths(JSON.stringify({ path: longest }))).toEqual([longest]);
		expect(extractPaths(JSON.stringify({ path: `${longest}c` }))).toEqual([]);
	});

	it("trims the value it keeps", () => {
		expect(extractPaths(JSON.stringify({ path: "  a/b.ts  " }))).toEqual(["a/b.ts"]);
	});

	it("dedupes repeated paths", () => {
		expect(extractPaths(JSON.stringify({ path: "a/b.ts", files: ["a/b.ts", "a/b.ts"] }))).toEqual(["a/b.ts"]);
	});

	it("caps the result at ten paths", () => {
		const many = Array.from({ length: 15 }, (_, i) => `dir/file-${i}.ts`);
		const out = extractPaths(JSON.stringify({ files: many }));
		expect(out).toHaveLength(10);
		expect(out).toEqual(many.slice(0, 10));
	});

	it("returns nothing for unparseable JSON", () => {
		expect(extractPaths("{not json")).toEqual([]);
		expect(extractPaths('{"path":')).toEqual([]);
	});

	it("returns nothing for JSON that is not an object", () => {
		expect(extractPaths("5")).toEqual([]);
		expect(extractPaths('"a/b.ts"')).toEqual([]);
		expect(extractPaths("null")).toEqual([]);
		expect(extractPaths("[]")).toEqual([]);
		expect(extractPaths("true")).toEqual([]);
	});

	it("returns nothing for nullish input", () => {
		expect(extractPaths(undefined)).toEqual([]);
		expect(extractPaths(null)).toEqual([]);
		expect(extractPaths("")).toEqual([]);
	});
});

describe("toolHeadline", () => {
	it("shows the first line of a bash command", () => {
		expect(toolHeadline("bash", JSON.stringify({ command: "ls -la\nsecond line" }))).toBe("bash · ls -la");
	});

	it("caps a long bash command at 100 characters", () => {
		const headline = toolHeadline("bash", JSON.stringify({ command: "x".repeat(140) }));
		expect(headline).toBe(`bash · ${"x".repeat(100)}…`);
	});

	it("falls back to a bare 'bash' when the arguments do not parse or carry no command", () => {
		expect(toolHeadline("bash", "{oops")).toBe("bash");
		expect(toolHeadline("bash", JSON.stringify({}))).toBe("bash");
		expect(toolHeadline("bash", JSON.stringify({ command: "" }))).toBe("bash");
		expect(toolHeadline("bash", undefined)).toBe("bash");
		expect(toolHeadline("bash", null)).toBe("bash");
		expect(toolHeadline("bash", "5")).toBe("bash");
	});

	it("shows the first path plus how many more there are", () => {
		expect(toolHeadline("edit", JSON.stringify({ path: "novel.md" }))).toBe("edit · novel.md");
		expect(toolHeadline("edit", JSON.stringify({ files: ["a/b.ts", "c/d.ts"] }))).toBe("edit · a/b.ts (+1)");
		expect(toolHeadline("edit", JSON.stringify({ files: ["a/b.ts", "c/d.ts", "e/f.ts"] }))).toBe("edit · a/b.ts (+2)");
	});

	it("falls back to a flat argument preview when there is no path", () => {
		expect(toolHeadline("search", JSON.stringify({ query: "hello" }))).toBe('search · "query":"hello"');
	});

	it("falls back to the bare tool name when there is nothing to show", () => {
		expect(toolHeadline("ping", "{}")).toBe("ping");
		expect(toolHeadline("ping", "")).toBe("ping");
		expect(toolHeadline(undefined, undefined)).toBe("tool");
		expect(toolHeadline(null, null)).toBe("tool");
	});
});

describe("blockText", () => {
	it("joins the matching blocks with newlines", () => {
		const blocks: ContentBlock[] = [
			{ type: "text", text: "one" },
			{ type: "thinking", thinking: "ignored" },
			{ type: "text", text: "two" },
		];
		expect(blockText(blocks, "text", "text")).toBe("one\ntwo");
	});

	it("skips non-string, missing and whitespace-only fields", () => {
		expect(blockText([{ type: "text", text: 5 }], "text", "text")).toBe("");
		expect(blockText([{ type: "text" }], "text", "text")).toBe("");
		expect(blockText([{ type: "text", text: "   " }], "text", "text")).toBe("");
	});

	it("keeps the untrimmed value of a block it accepted", () => {
		expect(blockText([{ type: "text", text: " padded " }], "text", "text")).toBe(" padded ");
	});

	it("accepts a missing block list", () => {
		expect(blockText(undefined, "text", "text")).toBe("");
		expect(blockText([], "text", "text")).toBe("");
	});

	it("reads any field, not just text", () => {
		expect(blockText([{ type: "thinking", thinking: "deep" }], "thinking", "thinking")).toBe("deep");
	});
});
