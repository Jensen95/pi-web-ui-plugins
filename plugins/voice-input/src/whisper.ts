/**
 * voice-input pure helpers - model tiers, language mapping and WAV decoding.
 *
 * Everything here is a pure function with no host, no network and no filesystem,
 * which is what makes the interesting parts of this plugin unit-testable: the
 * routes in index.ts only combine these with the two transcription engines.
 *
 * The WAV decoder exists because the local Whisper pipeline wants a mono
 * Float32Array at 16kHz. The browser records exactly that (an AudioWorklet
 * encodes 16kHz mono 16-bit WAV on the fly, so no ffmpeg is needed on the
 * server), but other sample rates, channel counts and bit depths are accepted
 * anyway - a hand-written encoder drifting a little must not blow up the
 * request.
 */

/** Local model tier -> HuggingFace model id. This is a whitelist: the install
 *  route accepts nothing else, which closes the "user-controlled URL downloads
 *  anything" hole. */
export const LOCAL_MODELS = {
	/** ~150MB, fine for short sentences, first choice on an old machine. */
	tiny: "Xenova/whisper-tiny",
	/** ~290MB, clearly more accurate on long sentences (the default). */
	base: "Xenova/whisper-base",
	/** ~500MB, 244M parameters, far fewer homophone mistakes; 3-4x slower than
	 *  base when transcribing on a CPU. */
	small: "Xenova/whisper-small",
} as const;

/** A local model tier name. */
export type LocalModelSize = keyof typeof LOCAL_MODELS;

/** One tier as the client sees it in GET /settings. */
export interface LocalModelTier {
	size: LocalModelSize;
	model: string;
	/** Rough download size in MB, for the install prompt. */
	approxMb: number;
}

/** The tiers, cheapest first. */
export const LOCAL_MODEL_TIERS: readonly LocalModelTier[] = [
	{ size: "tiny", model: LOCAL_MODELS.tiny, approxMb: 150 },
	{ size: "base", model: LOCAL_MODELS.base, approxMb: 290 },
	{ size: "small", model: LOCAL_MODELS.small, approxMb: 500 },
];

/** Tier name -> model id; anything else is null. */
export function resolveLocalModel(size: unknown): string | null {
	const s = typeof size === "string" ? size.trim().toLowerCase() : "";
	return Object.prototype.hasOwnProperty.call(LOCAL_MODELS, s) ? LOCAL_MODELS[s as LocalModelSize] : null;
}

/** Trim a value that is only usable when it is a string. */
export function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** Plugin language (zh-CN / en-US ...) -> remote Whisper `language` (ISO-639-1). */
export function whisperLang(lang: unknown): string {
	const l = str(lang).toLowerCase();
	if (l.startsWith("zh")) return "zh";
	if (l.startsWith("en")) return "en";
	if (l.startsWith("ja")) return "ja";
	if (l.startsWith("ko")) return "ko";
	if (l.startsWith("fr")) return "fr";
	if (l.startsWith("de")) return "de";
	if (l.startsWith("es")) return "es";
	if (l.startsWith("ru")) return "ru";
	if (l.startsWith("it")) return "it";
	if (l.startsWith("pt")) return "pt";
	return "";
}

/** Plugin language -> local transformers.js Whisper `language` (English name). */
export function whisperFullLang(lang: unknown): string {
	const l = str(lang).toLowerCase();
	if (l.startsWith("zh")) return "chinese";
	if (l.startsWith("en")) return "english";
	if (l.startsWith("ja")) return "japanese";
	if (l.startsWith("ko")) return "korean";
	if (l.startsWith("fr")) return "french";
	if (l.startsWith("de")) return "german";
	if (l.startsWith("es")) return "spanish";
	if (l.startsWith("ru")) return "russian";
	if (l.startsWith("it")) return "italian";
	if (l.startsWith("pt")) return "portuguese";
	return "";
}

/** Base URL + path, tolerating trailing slashes on the base. */
export function joinUrl(base: unknown, path: string): string {
	return `${str(base).replace(/\/+$/, "")}${path}`;
}

/** Upload file extension for an audio mime type (what the remote API keys off). */
export function audioExt(mime: string): string {
	if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
	if (mime.includes("ogg")) return "ogg";
	if (mime.includes("wav")) return "wav";
	return "webm";
}

/** Linear resampling. */
export function resampleLinear(
	samples: Float32Array | ArrayLike<number>,
	fromRate: number,
	toRate: number,
): Float32Array {
	const src = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? []);
	if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
		throw new Error("invalid sample rate");
	}
	if (src.length === 0) return new Float32Array(0);
	if (fromRate === toRate) return Float32Array.from(src);
	const outLen = Math.max(1, Math.round((src.length * toRate) / fromRate));
	const out = new Float32Array(outLen);
	const ratio = src.length / outLen;
	for (let i = 0; i < outLen; i++) {
		const pos = i * ratio;
		const i0 = Math.floor(pos);
		const i1 = Math.min(i0 + 1, src.length - 1);
		const frac = pos - i0;
		out[i] = src[i0] * (1 - frac) + src[i1] * frac;
	}
	return out;
}

function readAscii(view: DataView, offset: number, len: number): string {
	let s = "";
	for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
	return s;
}

/**
 * WAV (PCM or float) -> 16kHz mono Float32Array. Thrown messages are written for
 * the user: they travel straight out as the body of a 415.
 */
export function decodeWav16k(buf: Uint8Array): Float32Array {
	const u8 = Buffer.isBuffer(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf;
	if (!(u8 instanceof Uint8Array) || u8.length < 44) throw new Error("the audio is not a valid WAV (too short)");
	const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
		throw new Error("the audio is not a valid WAV (no RIFF/WAVE header)");
	}
	// Walk the chunks: fmt carries the format, data carries the samples; anything
	// else (fact, LIST, ...) is skipped.
	let audioFormat = 0;
	let channels = 0;
	let sampleRate = 0;
	let bitsPerSample = 0;
	let dataStart = -1;
	let dataLen = 0;
	let off = 12;
	while (off + 8 <= u8.length) {
		const id = readAscii(view, off, 4);
		const size = view.getUint32(off + 4, true);
		if (id === "fmt " && size >= 16) {
			audioFormat = view.getUint16(off + 8, true);
			channels = view.getUint16(off + 10, true);
			sampleRate = view.getUint32(off + 12, true);
			bitsPerSample = view.getUint16(off + 22, true);
		} else if (id === "data") {
			dataStart = off + 8;
			dataLen = Math.min(size, u8.length - dataStart);
		}
		off += 8 + size + (size % 2);
	}
	if (audioFormat !== 1 && audioFormat !== 3) {
		throw new Error(`unsupported WAV encoding (format=${audioFormat}, PCM or float only)`);
	}
	if (channels < 1 || channels > 8) throw new Error("odd WAV channel count");
	if (!Number.isFinite(sampleRate) || sampleRate < 3000 || sampleRate > 192000) throw new Error("odd WAV sample rate");
	if (![8, 16, 24, 32].includes(bitsPerSample)) throw new Error(`unsupported WAV bit depth (${bitsPerSample}bit)`);
	if (audioFormat === 3 && bitsPerSample !== 32) throw new Error("a float WAV must be 32bit");
	if (dataStart < 0 || dataLen <= 0) throw new Error("the WAV carries no sample data");
	const bytesPerSample = bitsPerSample / 8;
	const frames = Math.floor(dataLen / (bytesPerSample * channels));
	if (frames <= 0) throw new Error("the WAV carries no sample data");
	const mono = new Float32Array(frames);
	const dv = new DataView(u8.buffer, u8.byteOffset + dataStart, dataLen - (dataLen % (bytesPerSample * channels)));
	for (let f = 0; f < frames; f++) {
		let sum = 0;
		for (let c = 0; c < channels; c++) {
			const p = (f * channels + c) * bytesPerSample;
			let v: number;
			if (audioFormat === 3) v = dv.getFloat32(p, true);
			else if (bitsPerSample === 8) v = (dv.getUint8(p) - 128) / 128;
			else if (bitsPerSample === 16) v = dv.getInt16(p, true) / 32768;
			else if (bitsPerSample === 24) {
				const b0 = dv.getUint8(p);
				const b1 = dv.getUint8(p + 1);
				const b2 = dv.getInt8(p + 2);
				v = (b2 * 65536 + b1 * 256 + b0) / 8388608;
			} else v = dv.getInt32(p, true) / 2147483648;
			sum += v;
		}
		mono[f] = sum / channels;
	}
	return resampleLinear(mono, sampleRate, 16000);
}
