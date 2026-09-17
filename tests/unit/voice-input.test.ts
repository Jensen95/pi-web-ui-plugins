/**
 * voice-input server tests.
 *
 * Everything here runs offline: no model is downloaded, no npm install is
 * spawned and no real ~/.pi-web is touched. host.ensureDeps is the mock host's
 * (it resolves without installing anything) or a stub the test controls, and the
 * plugin directory is a temporary directory, so the createRequire resolution of
 * "@xenova/transformers" fails the way it does on a machine that never installed
 * the runtime - which is exactly the error path worth locking down.
 *
 * Covered: settings redaction (the API key never leaves the server), the pure
 * engine-selection and language helpers, WAV decoding, route error mapping and
 * the single-flight install guard.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockHost, type MockHost } from "../helpers/mock-host";
import voiceInput, { resolveEngine, selectEngine, shouldFallBackToRemote } from "../../plugins/voice-input/src/index";
import {
	LOCAL_MODELS,
	audioExt,
	decodeWav16k,
	joinUrl,
	resampleLinear,
	resolveLocalModel,
	whisperFullLang,
	whisperLang,
} from "../../plugins/voice-input/src/whisper";

const KEY = "sk-super-secret-key";

/** 16kHz mono 16-bit WAV carrying `frames` silent samples. */
function wav(frames: number, sampleRate = 16000): Buffer {
	const data = Buffer.alloc(frames * 2);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

let dir: string;
let host: MockHost;
let deactivate: (() => void) | undefined;

function activate(settings: Record<string, unknown>, storage: Record<string, unknown> = {}): MockHost {
	host = createMockHost({ dir, permissions: ["http"], settings, storage });
	deactivate = voiceInput.activate(host) as () => void;
	return host;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "voice-input-"));
});

afterEach(() => {
	deactivate?.();
	deactivate = undefined;
	rmSync(dir, { recursive: true, force: true });
});

describe("pure helpers", () => {
	it("maps model tiers and rejects anything outside the whitelist", () => {
		expect(resolveLocalModel("tiny")).toBe(LOCAL_MODELS.tiny);
		expect(resolveLocalModel(" BASE ")).toBe(LOCAL_MODELS.base);
		expect(resolveLocalModel("small")).toBe(LOCAL_MODELS.small);
		expect(resolveLocalModel("https://evil.example/model")).toBeNull();
		expect(resolveLocalModel(42)).toBeNull();
	});

	it("maps plugin languages to both Whisper spellings", () => {
		expect(whisperLang("en-US")).toBe("en");
		expect(whisperFullLang("en-US")).toBe("english");
		expect(whisperLang("pt-BR")).toBe("pt");
		expect(whisperLang("xx-YY")).toBe("");
		expect(whisperFullLang(null)).toBe("");
	});

	it("joins a base URL with or without a trailing slash", () => {
		expect(joinUrl("https://api.example/v1/", "/audio/transcriptions")).toBe(
			"https://api.example/v1/audio/transcriptions",
		);
		expect(joinUrl("https://api.example/v1", "/audio/transcriptions")).toBe(
			"https://api.example/v1/audio/transcriptions",
		);
	});

	it("picks the upload extension from the mime type", () => {
		expect(audioExt("audio/wav")).toBe("wav");
		expect(audioExt("audio/mp4")).toBe("m4a");
		expect(audioExt("audio/ogg")).toBe("ogg");
		expect(audioExt("audio/anything-else")).toBe("webm");
	});

	it("resamples linearly and refuses impossible rates", () => {
		expect(resampleLinear(new Float32Array([0, 1]), 32000, 16000).length).toBe(1);
		expect(resampleLinear(new Float32Array(0), 16000, 16000).length).toBe(0);
		expect(() => resampleLinear(new Float32Array([0]), 0, 16000)).toThrow();
	});

	it("decodes a WAV to 16kHz mono and rejects what is not one", () => {
		expect(decodeWav16k(wav(1600)).length).toBe(1600);
		// 32kHz input halves down to 16kHz.
		expect(decodeWav16k(wav(3200, 32000)).length).toBe(1600);
		expect(() => decodeWav16k(Buffer.alloc(10))).toThrow(/too short/);
		expect(() => decodeWav16k(Buffer.alloc(64))).toThrow(/RIFF/);
	});

	it("selects the engine the way the routes do", () => {
		expect(resolveEngine("LOCAL")).toBe("local");
		expect(resolveEngine("nonsense")).toBe("auto");
		expect(selectEngine("auto", true, true)).toBe("local");
		expect(selectEngine("auto", false, true)).toBe("remote");
		expect(selectEngine("auto", false, false)).toBe("unconfigured");
		expect(selectEngine("local", false, true)).toBe("local-missing");
		expect(selectEngine("remote", true, false)).toBe("unconfigured");
		expect(selectEngine("remote", false, true)).toBe("remote");
	});

	it("falls back to remote only for server-side local failures", () => {
		expect(shouldFallBackToRemote(502, true)).toBe(true);
		expect(shouldFallBackToRemote(415, true)).toBe(false);
		expect(shouldFallBackToRemote(400, true)).toBe(false);
		expect(shouldFallBackToRemote(502, false)).toBe(false);
	});
});

describe("GET /settings", () => {
	it("reports public configuration and never the API key", async () => {
		activate({
			lang: "en-US",
			engine: "remote",
			localModel: "small",
			transcribeUrl: "https://api.example/v1",
			transcribeKey: KEY,
			transcribeModel: "whisper-1",
		});
		const res = await host.callRoute("GET", "/settings");
		expect(res.statusCode).toBe(200);
		const body = res.body as Record<string, unknown>;
		expect(body).toMatchObject({
			lang: "en-US",
			serverFallback: true,
			engine: "remote",
			localModel: "small",
			serverReady: true,
			localReady: false,
		});
		expect(JSON.stringify(body)).not.toContain(KEY);
		expect(Object.keys(body)).not.toContain("transcribeKey");
		expect(body.localModels).toEqual([
			{ size: "tiny", model: LOCAL_MODELS.tiny, approxMb: 150, installed: false },
			{ size: "base", model: LOCAL_MODELS.base, approxMb: 290, installed: false },
			{ size: "small", model: LOCAL_MODELS.small, approxMb: 500, installed: false },
		]);
	});

	it("reports localReady once the wanted model is marked installed", async () => {
		activate({ engine: "local", localModel: "tiny" }, { whisperModels: { [LOCAL_MODELS.tiny]: true } });
		const body = (await host.callRoute("GET", "/settings")).body as Record<string, unknown>;
		expect(body.localReady).toBe(true);
		expect(body.serverReady).toBe(false);
	});

	it("no route reply ever carries the key", async () => {
		activate({ engine: "auto", transcribeUrl: "https://api.example/v1", transcribeKey: KEY });
		const replies = [
			await host.callRoute("GET", "/settings"),
			await host.callRoute("GET", "/local-status"),
			await host.callRoute("DELETE", "/local"),
			await host.callRoute("POST", "/transcribe", { body: Buffer.alloc(0) }),
		];
		for (const res of replies) expect(JSON.stringify(res.body ?? {})).not.toContain(KEY);
	});
});

describe("GET /local-status", () => {
	it("reports the idle state with the wanted model", async () => {
		activate({ localModel: "base" }, { whisperModels: { [LOCAL_MODELS.base]: true } });
		const res = await host.callRoute("GET", "/local-status");
		expect(res.body).toEqual({
			installing: false,
			progress: null,
			phase: "",
			error: "",
			ready: true,
			model: LOCAL_MODELS.base,
			models: [LOCAL_MODELS.base],
			loaded: false,
		});
	});
});

describe("POST /transcribe", () => {
	it("400s an empty body", async () => {
		activate({ engine: "remote", transcribeUrl: "https://api.example/v1", transcribeKey: KEY });
		const res = await host.callRoute("POST", "/transcribe", { body: Buffer.alloc(0) });
		expect(res.statusCode).toBe(400);
		expect(res.body).toEqual({ error: expect.stringContaining("empty") });
	});

	it("501s when the engine is local and nothing is installed", async () => {
		activate({ engine: "local" });
		const res = await host.callRoute("POST", "/transcribe", { body: wav(16000) });
		expect(res.statusCode).toBe(501);
		expect(res.body).toEqual({ error: expect.stringContaining("not installed") });
	});

	it("501s when nothing at all is configured", async () => {
		activate({ engine: "auto" });
		const res = await host.callRoute("POST", "/transcribe", { body: wav(16000) });
		expect(res.statusCode).toBe(501);
		expect(res.body).toEqual({ error: expect.stringContaining("install local Whisper") });
	});

	it("413s a recording over the local ceiling", async () => {
		activate({ engine: "local" }, { whisperModels: { [LOCAL_MODELS.base]: true } });
		const res = await host.callRoute("POST", "/transcribe", { body: Buffer.alloc(16 * 1024 * 1024) });
		expect(res.statusCode).toBe(413);
	});

	it("415s a local request whose body is not a WAV", async () => {
		activate({ engine: "local" }, { whisperModels: { [LOCAL_MODELS.base]: true } });
		const res = await host.callRoute("POST", "/transcribe", {
			body: Buffer.from("this is not audio at all, not even close"),
			headers: { "content-type": "audio/webm" },
		});
		expect(res.statusCode).toBe(415);
		expect(res.body).toEqual({ error: expect.stringContaining("only takes WAV") });
	});

	it("400s a local request whose recording is under 0.1 second", async () => {
		activate({ engine: "local" }, { whisperModels: { [LOCAL_MODELS.base]: true } });
		const res = await host.callRoute("POST", "/transcribe", { body: wav(100) });
		expect(res.statusCode).toBe(400);
		expect(res.body).toEqual({ error: expect.stringContaining("too short") });
	});

	it("does not fall back to remote when auto hits a client-side local failure", async () => {
		activate(
			{ engine: "auto", transcribeUrl: "https://api.example/v1", transcribeKey: KEY },
			{ whisperModels: { [LOCAL_MODELS.base]: true } },
		);
		const res = await host.callRoute("POST", "/transcribe", { body: Buffer.from("definitely not a wav file body") });
		// A 415 means the remote would reject it too, so no request goes out.
		expect(res.statusCode).toBe(415);
	});

	it("accepts a base64 JSON envelope as well as raw bytes", async () => {
		activate({ engine: "local" }, { whisperModels: { [LOCAL_MODELS.base]: true } });
		const res = await host.callRoute("POST", "/transcribe", { body: { dataBase64: wav(100).toString("base64") } });
		// Decoded far enough to reach the "too short" guard, which proves the
		// envelope was read as audio rather than dropped.
		expect(res.statusCode).toBe(400);
	});
});

describe("POST /local-install", () => {
	it("409s while the engine is remote only", async () => {
		activate({ engine: "remote", transcribeUrl: "https://api.example/v1", transcribeKey: KEY });
		const res = await host.callRoute("POST", "/local-install", { body: {} });
		expect(res.statusCode).toBe(409);
	});

	it("is single flight: a second click is deduped, not a second install", async () => {
		activate({ engine: "local" });
		// A dependency install that never finishes keeps the flight open, which is
		// what makes the guard observable without downloading anything.
		let depCalls = 0;
		host.ensureDeps = () => {
			depCalls += 1;
			return new Promise<boolean>(() => {});
		};

		const first = await host.callRoute("POST", "/local-install", { body: { model: "tiny" } });
		expect(first.statusCode).toBe(202);
		expect(first.body).toMatchObject({ started: true, installing: true });
		expect((first.body as Record<string, unknown>).deduped).toBeUndefined();

		const second = await host.callRoute("POST", "/local-install", { body: { model: "small" } });
		expect(second.statusCode).toBe(200);
		expect(second.body).toMatchObject({ started: true, deduped: true, installing: true });
		expect(depCalls).toBe(1);

		// An uninstall must not race the install either.
		const remove = await host.callRoute("DELETE", "/local");
		expect(remove.statusCode).toBe(409);
	});

	it("records the runtime error instead of rejecting when the entry cannot be resolved", async () => {
		activate({ engine: "local" });
		const res = await host.callRoute("POST", "/local-install", { body: { model: "tiny" } });
		expect(res.statusCode).toBe(202);
		// ensureDeps resolves true in the mock but nothing was really installed, so
		// createRequire cannot resolve the entry: the failure lands in local.error.
		for (let i = 0; i < 50; i++) {
			const status = (await host.callRoute("GET", "/local-status")).body as Record<string, unknown>;
			if (!status.installing) {
				expect(status.error).toMatch(/entry cannot be resolved/);
				expect(status.ready).toBe(false);
				return;
			}
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error("the install never finished");
	});
});

describe("DELETE /local", () => {
	it("clears the installed marker and reports the cache as freed", async () => {
		activate({ engine: "local" }, { whisperModels: { [LOCAL_MODELS.base]: true } });
		const res = await host.callRoute("DELETE", "/local");
		expect(res.body).toEqual({ ok: true, freed: true });
		expect((await host.callRoute("GET", "/local-status")).body).toMatchObject({ ready: false, models: [] });
	});
});

describe("lifecycle", () => {
	it("unregisters every route on deactivate", async () => {
		activate({ engine: "auto" });
		expect(host.recorded.routes.size).toBe(5);
		deactivate?.();
		deactivate = undefined;
		expect(host.recorded.routes.size).toBe(0);
	});
});
