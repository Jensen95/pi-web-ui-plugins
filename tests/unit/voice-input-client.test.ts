/**
 * The pure helpers behind the voice-input mic button. Everything that can be decided
 * without a browser is exported from src/client.ts and tested here under the node
 * environment; the DOM plumbing (overlay, AudioWorklet capture) is not reachable from
 * node, which is exactly why importing the module must stay side-effect free.
 */
import { describe, expect, it } from "vitest";
import client, {
	ACTION,
	apiBaseFrom,
	browserRecognitionSupported,
	collectTranscript,
	concatSamples,
	DEFAULT_SETTINGS,
	downmixChannels,
	encodeWav,
	formatElapsed,
	formatInstallProgress,
	MESSAGES,
	normalizeSettings,
	parseTranscribeResponse,
	register,
	resampleTo16k,
	selectEngine,
	serverUsable,
	srExplain,
} from "../../plugins/voice-input/src/client.ts";

const text = (bytes: Uint8Array, offset: number, length: number): string =>
	String.fromCharCode(...bytes.slice(offset, offset + length));

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

describe("module entry", () => {
	it("imports in node without a browser and still exposes mount", () => {
		expect(typeof client.mount).toBe("function");
		expect(client.mount()).toBeTypeOf("function");
	});

	it("registers nothing when there is no host to register with", () => {
		expect(register()).toBe(false);
		expect(browserRecognitionSupported()).toBe(false);
	});

	it("uses the action id the manifest's composer button triggers", () => {
		expect(ACTION).toBe("voice-input:toggle");
	});
});

describe("encodeWav", () => {
	it("writes a canonical 44-byte 16 kHz mono 16-bit header", () => {
		const bytes = encodeWav(new Float32Array([0, 0, 0, 0]), 16000);
		const v = view(bytes);
		expect(bytes.length).toBe(44 + 4 * 2);
		expect(text(bytes, 0, 4)).toBe("RIFF");
		expect(v.getUint32(4, true)).toBe(36 + 8); // file size minus the first 8 bytes
		expect(text(bytes, 8, 4)).toBe("WAVE");
		expect(text(bytes, 12, 4)).toBe("fmt ");
		expect(v.getUint32(16, true)).toBe(16); // PCM fmt chunk size
		expect(v.getUint16(20, true)).toBe(1); // PCM
		expect(v.getUint16(22, true)).toBe(1); // mono
		expect(v.getUint32(24, true)).toBe(16000); // sample rate
		expect(v.getUint32(28, true)).toBe(32000); // byte rate = rate * blockAlign
		expect(v.getUint16(32, true)).toBe(2); // block align
		expect(v.getUint16(34, true)).toBe(16); // bits per sample
		expect(text(bytes, 36, 4)).toBe("data");
		expect(v.getUint32(40, true)).toBe(8); // data bytes
	});

	it("writes little-endian samples and clamps beyond full scale", () => {
		const bytes = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16000);
		const v = view(bytes);
		expect(v.getInt16(44, true)).toBe(0);
		expect(v.getInt16(46, true)).toBe(32767);
		expect(v.getInt16(48, true)).toBe(-32768);
		expect(v.getInt16(50, true)).toBe(32767);
		expect(v.getInt16(52, true)).toBe(-32768);
		expect(v.getInt16(54, true)).toBe(Math.round(0.5 * 32767));
		// Little-endian check on the raw bytes, not just the DataView read.
		expect(bytes[46]).toBe(0xff);
		expect(bytes[47]).toBe(0x7f);
	});

	it("keeps the header consistent for an empty take and another sample rate", () => {
		const bytes = encodeWav(new Float32Array(0), 48000);
		const v = view(bytes);
		expect(bytes.length).toBe(44);
		expect(v.getUint32(24, true)).toBe(48000);
		expect(v.getUint32(28, true)).toBe(96000);
		expect(v.getUint32(40, true)).toBe(0);
		expect(v.getUint32(4, true)).toBe(36);
	});

	it("falls back to 16 kHz for a bogus sample rate", () => {
		expect(view(encodeWav(new Float32Array(1), Number.NaN)).getUint32(24, true)).toBe(16000);
	});
});

describe("concatSamples", () => {
	it("joins worklet blocks end to end in order", () => {
		const out = concatSamples([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])]);
		expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
	});

	it("returns an empty buffer for no blocks", () => {
		expect(concatSamples([]).length).toBe(0);
	});
});

describe("downmixChannels", () => {
	it("copies a mono channel instead of aliasing it", () => {
		const input = new Float32Array([0.25, -0.25]);
		const out = downmixChannels([input]);
		out[0] = 1;
		expect(input[0]).toBe(0.25);
	});

	it("averages channels sample by sample", () => {
		const out = downmixChannels([new Float32Array([1, -1]), new Float32Array([0, 1])]);
		expect(out[0]).toBeCloseTo(0.5, 6);
		expect(out[1]).toBeCloseTo(0, 6);
	});

	it("returns nothing for no channels", () => {
		expect(downmixChannels([]).length).toBe(0);
	});
});

describe("resampleTo16k", () => {
	it("passes 16 kHz input through as a copy", () => {
		const input = new Float32Array([0.1, 0.2, 0.3]);
		const out = resampleTo16k(input, 16000);
		expect(Array.from(out)).toEqual(Array.from(input));
		expect(out).not.toBe(input);
	});

	it("halves the length when downsampling from 32 kHz", () => {
		expect(resampleTo16k(new Float32Array(3200), 32000).length).toBe(1600);
	});

	it("interpolates between neighbouring samples", () => {
		const out = resampleTo16k(new Float32Array([0, 1, 2, 3]), 32000);
		expect(out.length).toBe(2);
		expect(out[0]).toBeCloseTo(0, 6);
		expect(out[1]).toBeCloseTo(2, 6);
	});

	it("handles an empty take", () => {
		expect(resampleTo16k(new Float32Array(0), 44100).length).toBe(0);
	});
});

describe("normalizeSettings", () => {
	it("fills every field from defaults when the server answers with junk", () => {
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
	});

	it("keeps the server's values and treats readiness as strictly boolean", () => {
		expect(normalizeSettings({ lang: "de-DE", engine: "server", localModel: "small", localReady: true })).toEqual({
			lang: "de-DE",
			serverFallback: true,
			engine: "server",
			localModel: "small",
			serverReady: false,
			localReady: true,
		});
		expect(normalizeSettings({ localReady: "yes", serverReady: 1 }).localReady).toBe(false);
	});

	it("only turns the fallback off for an explicit false", () => {
		expect(normalizeSettings({ serverFallback: false }).serverFallback).toBe(false);
		expect(normalizeSettings({ serverFallback: undefined }).serverFallback).toBe(true);
	});
});

describe("serverUsable", () => {
	const cfg = (patch: Partial<typeof DEFAULT_SETTINGS>) => ({ ...DEFAULT_SETTINGS, ...patch });

	it("needs the fallback switch and one ready backend", () => {
		expect(serverUsable(cfg({ localReady: true }))).toBe(true);
		expect(serverUsable(cfg({ serverReady: true }))).toBe(true);
		expect(serverUsable(cfg({}))).toBe(false);
		expect(serverUsable(cfg({ localReady: true, serverFallback: false }))).toBe(false);
		expect(serverUsable(null)).toBe(false);
	});
});

describe("selectEngine", () => {
	const cfg = (patch: Partial<typeof DEFAULT_SETTINGS>) => ({ ...DEFAULT_SETTINGS, ...patch });

	it("prefers browser recognition on auto", () => {
		expect(selectEngine(cfg({ localReady: true }), true)).toBe("browser");
	});

	it("falls back to server recording when the browser cannot recognise", () => {
		expect(selectEngine(cfg({ localReady: true }), false)).toBe("server");
	});

	it("offers the install when neither path is available", () => {
		expect(selectEngine(cfg({}), false)).toBe("install");
		expect(selectEngine(null, false)).toBe("install");
	});

	it("honours an explicit engine preference, and degrades when it is not usable", () => {
		expect(selectEngine(cfg({ engine: "server", localReady: true }), true)).toBe("server");
		expect(selectEngine(cfg({ engine: "server" }), true)).toBe("install");
		expect(selectEngine(cfg({ engine: "browser", serverReady: true }), false)).toBe("server");
	});
});

describe("srExplain", () => {
	it("names permission problems so retrying is not suggested", () => {
		expect(srExplain("not-allowed")).toEqual({ message: MESSAGES.micDenied, kind: "denied" });
		expect(srExplain("service-not-allowed").kind).toBe("denied");
	});

	it("separates network, silence, busy and abort", () => {
		expect(srExplain("network").kind).toBe("network");
		expect(srExplain("no-speech").kind).toBe("nospeech");
		expect(srExplain("audio-capture").kind).toBe("nospeech");
		expect(srExplain("audio-busy").kind).toBe("busy");
		expect(srExplain("aborted").kind).toBe("aborted");
		expect(srExplain("language-not-supported").kind).toBe("unsupported");
	});

	it("keeps an unknown code in the message instead of swallowing it", () => {
		expect(srExplain("weird-code")).toEqual({ message: `${MESSAGES.noSpeech} (weird-code)`, kind: "other" });
		expect(srExplain(undefined).message).toBe(`${MESSAGES.noSpeech} (unknown)`);
	});
});

describe("apiBaseFrom", () => {
	it("derives the plugin api base from the module url", () => {
		expect(apiBaseFrom("https://host.example/plugins/voice-input/client/entry.mjs")).toBe(
			"https://host.example/plugins-api/voice-input",
		);
	});

	it("keeps a reverse proxy sub-path prefix", () => {
		expect(apiBaseFrom("http://host.example/pi/plugins/voice-input/client/entry.mjs")).toBe(
			"http://host.example/pi/plugins-api/voice-input",
		);
	});

	it("falls back to a relative base for a non-http or unparsable url", () => {
		expect(apiBaseFrom("file:///tmp/entry.mjs")).toBe("/plugins-api/voice-input");
		expect(apiBaseFrom("not a url")).toBe("/plugins-api/voice-input");
	});
});

describe("formatElapsed", () => {
	it("formats mm:ss with padding", () => {
		expect(formatElapsed(0)).toBe("00:00");
		expect(formatElapsed(7_400)).toBe("00:07");
		expect(formatElapsed(65_000)).toBe("01:05");
		expect(formatElapsed(600_000)).toBe("10:00");
	});

	it("never shows a negative or NaN clock", () => {
		expect(formatElapsed(-5000)).toBe("00:00");
		expect(formatElapsed(Number.NaN)).toBe("00:00");
	});
});

describe("formatInstallProgress", () => {
	it("shows percent and phase while installing", () => {
		expect(formatInstallProgress({ installing: true, progress: 42.4, phase: "model" })).toEqual({
			state: "installing",
			label: "Installing local Whisper... 42% (model)",
		});
		expect(formatInstallProgress({ installing: true }).label).toBe("Installing local Whisper...");
	});

	it("reports the server's error first", () => {
		const progress = formatInstallProgress({ installing: true, error: "disk full" });
		expect(progress.state).toBe("error");
		expect(progress.error).toBe("disk full");
		expect(progress.label).toContain("disk full");
	});

	it("reports ready and stays unknown for anything else", () => {
		expect(formatInstallProgress({ ready: true })).toEqual({ state: "ready", label: MESSAGES.installDone });
		expect(formatInstallProgress({}).state).toBe("unknown");
		expect(formatInstallProgress(undefined).state).toBe("unknown");
	});
});

describe("parseTranscribeResponse", () => {
	it("returns the trimmed transcript on success", () => {
		expect(parseTranscribeResponse(200, { text: "  hello there  " })).toBe("hello there");
		expect(parseTranscribeResponse(200, {})).toBe("");
		expect(parseTranscribeResponse(200, null)).toBe("");
	});

	it("throws the server's message and keeps the status for the 501 install path", () => {
		expect(() => parseTranscribeResponse(500, { error: "whisper crashed" })).toThrow("whisper crashed");
		try {
			parseTranscribeResponse(501, {});
			expect.unreachable("expected a throw");
		} catch (error) {
			expect((error as { status?: number }).status).toBe(501);
			expect((error as Error).message).toBe("transcribe 501");
		}
	});
});

describe("collectTranscript", () => {
	it("appends final results to the running text and keeps interim separate", () => {
		const event = {
			resultIndex: 0,
			results: [
				{ isFinal: true, 0: { transcript: "hello " } },
				{ isFinal: false, 0: { transcript: "wor" } },
			],
		};
		expect(collectTranscript(event, "")).toEqual({ final: "hello ", interim: "wor" });
	});

	it("starts at resultIndex so earlier finals are not counted twice", () => {
		const event = {
			resultIndex: 1,
			results: [
				{ isFinal: true, 0: { transcript: "hello " } },
				{ isFinal: true, 0: { transcript: "world" } },
			],
		};
		expect(collectTranscript(event, "hello ")).toEqual({ final: "hello world", interim: "" });
	});

	it("survives a malformed event", () => {
		expect(collectTranscript({}, "kept")).toEqual({ final: "kept", interim: "" });
		expect(collectTranscript({ results: [{}, { isFinal: true }] }, "")).toEqual({ final: "", interim: "" });
	});
});
