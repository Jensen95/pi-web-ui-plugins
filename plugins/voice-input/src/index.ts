/**
 * voice-input server entry - the server half of the voice input plugin.
 *
 * Two transcription engines (the `engine` setting, default auto):
 *   local  local Whisper (transformers.js + ONNX, runs on the CPU, no API key):
 *          one click installs the runtime through host.ensureDeps and downloads
 *          the model into this plugin's own directory
 *          (<dataDir>/plugins/voice-input/whisper-cache); the audio never leaves
 *          the machine;
 *   remote an OpenAI-compatible endpoint (POST {base}/audio/transcriptions).
 *   auto   local when it is installed, otherwise remote (when configured).
 *
 * The browser always sends 16kHz mono 16-bit WAV (encoded live in an
 * AudioWorklet, so the server needs no ffmpeg); the remote endpoint also accepts
 * other audio mime types.
 *
 * Routes (mounted at `/plugins-api/voice-input/*`, so the manifest needs the
 * `http` permission):
 *   GET    /settings      -> { lang, serverFallback, engine, localModel,
 *                             serverReady, localReady, localModels }
 *                            (the API key is never sent to the client)
 *   POST   /transcribe    -> audio bytes (WAV preferred, optional ?lang=),
 *                            replies { text, engine }
 *   GET    /local-status  -> { installing, progress, phase, error, ready, model,
 *                             models, loaded }
 *   POST   /local-install -> { started: true, ... } (body { model? }; single
 *                            flight, installs in the background)
 *   DELETE /local         -> delete the model cache (node_modules stays, so a
 *                            reinstall is fast)
 *
 * House rule: every handler turns its own throws into an HTTP status code and
 * never lets a promise reject out of it. The host only try/catches synchronous
 * throws, so an async rejection becomes an unhandledRejection that takes the
 * whole server down (image-toolkit hit exactly that).
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	LOCAL_MODELS,
	LOCAL_MODEL_TIERS,
	audioExt,
	decodeWav16k,
	joinUrl,
	resolveLocalModel,
	str,
	whisperFullLang,
	whisperLang,
} from "./whisper.ts";

/** Remote transcription gives up after two minutes. */
const REMOTE_TRANSCRIBE_TIMEOUT_MS = 120_000;
/** Remote Whisper caps a single file at 25MB; reject bigger locally rather than
 *  waste one upload finding out. */
const MAX_REMOTE_AUDIO_BYTES = 25 * 1024 * 1024;
/** Local WAV ceiling, 15MB (16k mono ~ 8 minutes, plenty for dictation). */
const MAX_LOCAL_AUDIO_BYTES = 15 * 1024 * 1024;
/** Hard cut for the decoded samples: 8 minutes at 16kHz. */
const MAX_LOCAL_SAMPLES = 16000 * 480;
/** Below this the recording is not worth sending to the model (0.1 second). */
const MIN_LOCAL_SAMPLES = 1600;
/** The transformers.js runtime (prebuilt ONNX, win/mac/linux, CPU only is fine). */
const TRANSFORMERS_SPEC = "@xenova/transformers@2.17.2";

// ---------------------------------------------------------------------------
// Host and runtime shapes
// ---------------------------------------------------------------------------

/** The request slice this plugin reads. A body may arrive pre-parsed (JSON) or
 *  the raw bytes may still have to be streamed off the request. */
export interface VoiceRequest {
	headers?: Record<string, string | undefined>;
	query?: Record<string, string | undefined>;
	body?: unknown;
	[Symbol.asyncIterator]?: () => AsyncIterator<Buffer | Uint8Array | string>;
}

/** The response slice this plugin writes. `headersSent` is typed loosely because
 *  it comes from the host's express response and is only ever tested for truth. */
export interface VoiceResponse {
	status(code: number): VoiceResponse;
	json(value: unknown): VoiceResponse;
	end(): void;
	headersSent?: unknown;
}

/** The slice of the pi-web-ui plugin host this entry uses. */
export interface VoicePluginHost {
	/** The plugin's own directory (<dataDir>/plugins/voice-input). */
	dir: string;
	route(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		handler: (req: VoiceRequest, res: VoiceResponse) => void | Promise<void>,
	): () => void;
	getSettings?(): Record<string, unknown>;
	onSettingsChanged?(handler: (values: Record<string, unknown>) => void): () => void;
	storage: {
		get<T>(key: string, fallback?: T): T | undefined;
		set(key: string, value: unknown): void;
		delete(key: string): void;
	};
	ensureDeps?(specs: string[], opts?: { onProgress?: (msg: string) => void }): Promise<boolean>;
	log(...args: unknown[]): void;
}

/** A transformers.js ASR pipeline, narrowed to what is actually called. */
export interface AsrPipeline {
	(audio: Float32Array, options?: Record<string, unknown>): Promise<{ text?: unknown } | null>;
	model?: { dispose?: () => Promise<void> | void };
}

/** Download progress as transformers.js reports it. */
interface ProgressEvent {
	status?: string;
	file?: unknown;
	progress?: unknown;
	loaded?: unknown;
	total?: unknown;
}

/** The transformers.js module surface this plugin uses. */
interface TransformersModule {
	pipeline(task: string, model: string, options?: Record<string, unknown>): Promise<AsrPipeline | null>;
	env: { cacheDir?: string };
}

/** An error that already knows which HTTP status it should become. */
export class HttpError extends Error {
	readonly statusCode: number;
	constructor(statusCode: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.statusCode = statusCode;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Message of anything that was thrown (JavaScript can throw non-Errors). */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The status an error asked for, or 0 when it is an ordinary failure. */
export function errorStatus(err: unknown): number {
	if (err instanceof HttpError) return err.statusCode;
	const code = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
	return typeof code === "number" ? code : 0;
}

// ---------------------------------------------------------------------------
// Pure decisions, kept out of activate() so they can be tested directly
// ---------------------------------------------------------------------------

/** The three engine settings; anything unrecognised means auto. */
export type Engine = "auto" | "local" | "remote";

/** Normalize the `engine` setting. */
export function resolveEngine(value: unknown): Engine {
	const e = str(value).toLowerCase();
	return e === "local" || e === "remote" ? e : "auto";
}

/** What a transcribe request should do, given the engine and what is ready. */
export type TranscribeRoute = "local" | "remote" | "local-missing" | "unconfigured";

/**
 * Engine selection. auto prefers local (free, offline) and falls back to remote;
 * local never silently goes online; remote never touches the local model.
 */
export function selectEngine(engine: Engine, localReady: boolean, remoteReady: boolean): TranscribeRoute {
	if (engine === "local") return localReady ? "local" : "local-missing";
	if (engine === "remote") return remoteReady ? "remote" : "unconfigured";
	if (localReady) return "local";
	return remoteReady ? "remote" : "unconfigured";
}

/**
 * After a local failure in `auto` mode: fall back to remote only when a remote is
 * configured and the failure was the local engine's fault. A 415 (not a WAV) or a
 * 400 (too short) is the caller's input, and the remote would fail the same way.
 */
export function shouldFallBackToRemote(status: number, remoteReady: boolean): boolean {
	return remoteReady && status !== 415 && status !== 400;
}

export default {
	activate(host: VoicePluginHost): () => void {
		const dir = host.dir;
		const cacheDir = join(dir, "whisper-cache");
		let cfg: Record<string, unknown> = host.getSettings?.() ?? {};
		const offSettings = host.onSettingsChanged?.((v) => {
			cfg = isRecord(v) ? v : {};
		});

		/** Local engine runtime state. It lives in memory (a restart clears it);
		 *  the "this model is installed" marker is persisted in host.storage. */
		const local: {
			installing: boolean;
			/** 0-100, null when unknown or outside a download phase. */
			progress: number | null;
			phase: string;
			error: string;
			pipe: AsrPipeline | null;
			loadedModel: string;
			transcribeBusy: boolean;
		} = {
			installing: false,
			progress: null,
			phase: "",
			error: "",
			pipe: null,
			loadedModel: "",
			transcribeBusy: false,
		};
		/** The single in-flight install, so two clicks never install twice. */
		let installFlight: Promise<void> | null = null;

		const engine = (): Engine => resolveEngine(cfg.engine);
		const wantedModelId = (): string => resolveLocalModel(cfg.localModel) ?? LOCAL_MODELS.base;
		const remoteReady = (): boolean => Boolean(str(cfg.transcribeUrl) && str(cfg.transcribeKey));
		const installedModels = (): Record<string, unknown> => {
			try {
				const v = host.storage.get<Record<string, unknown>>("whisperModels", {});
				return isRecord(v) ? v : {};
			} catch {
				return {};
			}
		};
		const localReady = (): boolean => Boolean(installedModels()[wantedModelId()]);

		const localStatus = () => ({
			installing: local.installing,
			progress: local.progress,
			phase: local.phase,
			error: local.error,
			ready: localReady(),
			model: wantedModelId(),
			/** Model ids already downloaded into the cache. */
			models: Object.keys(installedModels()),
			loaded: Boolean(local.pipe) && local.loadedModel === wantedModelId(),
		});

		/** Register a route whose handler can throw or reject freely: everything
		 *  becomes a status code here, and nothing escapes as an unhandledRejection. */
		const safe = (
			method: "GET" | "POST" | "DELETE",
			path: string,
			handler: (req: VoiceRequest, res: VoiceResponse) => Promise<void>,
		) =>
			host.route(method, path, async (req, res) => {
				try {
					await handler(req, res);
				} catch (err) {
					const msg = errorMessage(err);
					host.log(`voice-input ${method} ${path} failed:`, err);
					if (!res.headersSent) res.status(errorStatus(err) || 500).json({ error: msg || "internal error" });
					else res.end();
				}
			});

		/** Read the raw body (a small JSON envelope or a big binary upload; same
		 *  shape as image-toolkit's readBody). */
		async function readRaw(req: VoiceRequest): Promise<Buffer> {
			const b = req.body;
			if (isRecord(b) && typeof b.dataBase64 === "string") return Buffer.from(b.dataBase64, "base64");
			if (Buffer.isBuffer(b)) return b;
			if (b instanceof Uint8Array) return Buffer.from(b);
			if (typeof req[Symbol.asyncIterator] !== "function") return Buffer.alloc(0);
			const chunks: Buffer[] = [];
			for await (const c of req as AsyncIterable<Buffer | Uint8Array | string>) {
				chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
			}
			return Buffer.concat(chunks);
		}

		/* ---------------- local engine: install / status / remove ---------------- */

		async function importTransformers(): Promise<TransformersModule> {
			const ok = await host.ensureDeps?.([TRANSFORMERS_SPEC], {
				onProgress: (m) => {
					local.phase = str(m) || "Installing the local speech runtime...";
				},
			});
			if (!ok) {
				throw new Error(
					"the local speech runtime failed to install (npm install did not go through, check the network and retry)",
				);
			}
			// ESM cannot import a directory (ERR_UNSUPPORTED_DIR_IMPORT): resolve the
			// entry file through the package exports map with createRequire first,
			// then import that file URL (a file URL is always importable).
			const req = createRequire(join(dir, "index.mjs"));
			let entry: string;
			try {
				entry = req.resolve("@xenova/transformers");
			} catch {
				throw new Error(
					"the local speech runtime installed but its entry cannot be resolved (node_modules may be damaged, delete it and reinstall)",
				);
			}
			const mod: unknown = await import(pathToFileURL(entry).href);
			if (!isRecord(mod) || typeof mod.pipeline !== "function") {
				throw new Error("the local speech runtime failed to load (the dependency installed but cannot be imported)");
			}
			// SAFETY: the check above proves the module exposes pipeline(); env is part of
			// the same public transformers.js surface and is only written, never read back.
			const tf = mod as unknown as TransformersModule;
			tf.env.cacheDir = cacheDir;
			return tf;
		}

		/** The whole background install (single flight): runtime -> weights -> warmup.
		 *  Progress lands in local.*, which GET /local-status reports. */
		async function runInstall(modelId: string): Promise<void> {
			local.installing = true;
			local.progress = null;
			local.error = "";
			try {
				local.phase = "Installing the local speech runtime (a few minutes the first time)...";
				const tf = await importTransformers();
				local.phase = `Downloading the speech model (${modelId}, a few hundred MB the first time)...`;
				const seen = new Map<string, { loaded: number; total: number }>();
				const pipe = await tf.pipeline("automatic-speech-recognition", modelId, {
					progress_callback: (p: ProgressEvent) => {
						try {
							if (!isRecord(p)) return;
							if (p.status === "progress" && typeof p.progress === "number") {
								seen.set(String(p.file ?? ""), { loaded: Number(p.loaded) || 0, total: Number(p.total) || 0 });
								let l = 0;
								let t = 0;
								for (const v of seen.values()) {
									l += v.loaded;
									t += v.total;
								}
								if (t > 0) local.progress = Math.min(99, Math.round((l / t) * 100));
							} else if (p.status === "done") {
								const k = String(p.file ?? "");
								const v = seen.get(k);
								if (v) seen.set(k, { loaded: Math.max(v.loaded, v.total), total: v.total });
							}
						} catch {
							/* A failed progress report must not fail the install. */
						}
					},
				});
				if (!pipe) throw new Error("loading the speech model returned nothing");
				local.phase = "Warming up...";
				// Run three seconds of silence through it: that actually starts the onnx
				// session, so the first real sentence is not a cold start.
				try {
					await pipe(new Float32Array(16000 * 3), { language: "english", task: "transcribe" });
				} catch {
					/* A failed warmup is not fatal. */
				}
				try {
					if (local.pipe && local.loadedModel !== modelId) await local.pipe.model?.dispose?.();
				} catch {
					/* ignore */
				}
				local.pipe = pipe;
				local.loadedModel = modelId;
				const prev = installedModels();
				prev[modelId] = true;
				try {
					host.storage.set("whisperModels", prev);
				} catch {
					/* A failed marker write only means the next restart downloads again. */
				}
				local.progress = 100;
				local.phase = "Done";
				host.log(`voice-input local model ready: ${modelId}`);
			} catch (err) {
				local.error = errorMessage(err);
				host.log("voice-input local install failed:", err);
			} finally {
				local.installing = false;
				installFlight = null;
			}
		}

		/** The hot pipeline; lazily loaded when memory does not have it. Missing
		 *  weights are downloaded again automatically, which makes this self-healing. */
		async function getPipe(modelId: string): Promise<AsrPipeline> {
			if (local.pipe && local.loadedModel === modelId) return local.pipe;
			const tf = await importTransformers();
			try {
				if (local.pipe) await local.pipe.model?.dispose?.();
			} catch {
				/* ignore */
			}
			const pipe = await tf.pipeline("automatic-speech-recognition", modelId);
			if (!pipe) throw new Error("loading the speech model returned nothing");
			local.pipe = pipe;
			local.loadedModel = modelId;
			return pipe;
		}

		async function transcribeLocal(audio: Buffer, lang: string): Promise<string> {
			const modelId = wantedModelId();
			let samples: Float32Array;
			try {
				samples = decodeWav16k(audio);
			} catch (err) {
				throw new HttpError(415, `the local engine only takes WAV: ${errorMessage(err)}`);
			}
			if (samples.length < MIN_LOCAL_SAMPLES) {
				throw new HttpError(400, "the recording is too short (under 0.1 second), finish the sentence before releasing");
			}
			// Hard cut at 8 minutes so an overlong recording cannot pin the CPU.
			const capped = samples.length > MAX_LOCAL_SAMPLES ? samples.slice(0, MAX_LOCAL_SAMPLES) : samples;
			const pipe = await getPipe(modelId);
			const fullLang = whisperFullLang(lang);
			const out = await pipe(capped, {
				language: fullLang || undefined,
				task: "transcribe",
				chunk_length_s: 30,
				stride_length_s: 5,
			});
			const text = str(out?.text);
			if (!text) {
				throw new HttpError(
					502,
					"local transcription came back empty (probably silence), move closer to the microphone and retry",
				);
			}
			return text;
		}

		/* ---------------- remote engine (OpenAI compatible) ---------------- */

		async function transcribeRemote(audio: Buffer, mime: string, lang: string): Promise<string> {
			const baseUrl = str(cfg.transcribeUrl);
			const apiKey = str(cfg.transcribeKey);
			if (!baseUrl || !apiKey) {
				throw new HttpError(
					501,
					"server-side transcription is not configured: Settings -> interface plugins -> Voice Input -> fill in the transcription base URL and key, or install local Whisper with one click",
				);
			}
			if (audio.length > MAX_REMOTE_AUDIO_BYTES) {
				throw new HttpError(
					413,
					`the recording is too big (${(audio.length / 1048576).toFixed(1)}MB > 25MB), record it in parts`,
				);
			}
			const wl = whisperLang(lang);
			const form = new FormData();
			form.set("file", new Blob([new Uint8Array(audio)], { type: mime }), `voice.${audioExt(mime)}`);
			form.set("model", str(cfg.transcribeModel) || "whisper-1");
			if (wl) form.set("language", wl);
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), REMOTE_TRANSCRIBE_TIMEOUT_MS);
			let r: Response;
			try {
				r = await fetch(joinUrl(baseUrl, "/audio/transcriptions"), {
					method: "POST",
					headers: { Authorization: `Bearer ${apiKey}` },
					body: form,
					signal: ctrl.signal,
				});
			} catch (err) {
				const aborted = (err as { name?: string } | null | undefined)?.name === "AbortError";
				throw new HttpError(
					502,
					aborted
						? "transcription timed out (120s), record it in parts"
						: `the transcription endpoint is unreachable: ${errorMessage(err)}`,
				);
			} finally {
				clearTimeout(timer);
			}
			if (!r.ok) {
				const body = (await r.text().catch(() => "")).slice(0, 500);
				throw new HttpError(502, `the transcription endpoint failed with ${r.status}: ${body || r.statusText}`);
			}
			const data: unknown = await r.json().catch(() => ({}));
			return str(isRecord(data) ? data.text : "");
		}

		/* ---------------- routes ---------------- */

		/** Public configuration for the client. The key is never part of this. */
		const offGet = safe("GET", "/settings", async (_req, res) => {
			res.json({
				lang: str(cfg.lang) || "en-US",
				serverFallback: cfg.serverFallback !== false,
				engine: engine(),
				localModel: str(cfg.localModel) || "base",
				serverReady: remoteReady(),
				localReady: localReady(),
				localModels: LOCAL_MODEL_TIERS.map((tier) => ({ ...tier, installed: Boolean(installedModels()[tier.model]) })),
			});
		});

		const offStatus = safe("GET", "/local-status", async (_req, res) => {
			res.json(localStatus());
		});

		const offInstall = safe("POST", "/local-install", async (req, res) => {
			if (engine() === "remote") {
				res
					.status(409)
					.json({ error: 'the engine is set to "remote only": switch it to auto or local before installing' });
				return;
			}
			const body = isRecord(req.body) ? req.body : {};
			const modelId = resolveLocalModel(body.model) ?? wantedModelId();
			if (local.installing) {
				res.json({ started: true, deduped: true, ...localStatus() });
				return;
			}
			if (!existsSync(dir)) {
				res.status(500).json({ error: "the plugin directory is not writable, cannot install" });
				return;
			}
			local.phase = "Preparing...";
			installFlight = runInstall(modelId);
			void installFlight;
			res.status(202).json({ started: true, ...localStatus() });
		});

		const offUninstall = safe("DELETE", "/local", async (_req, res) => {
			if (local.installing) {
				res.status(409).json({ error: "an install is running, wait for it to finish before removing the model" });
				return;
			}
			try {
				if (local.pipe) await local.pipe.model?.dispose?.();
			} catch {
				/* ignore */
			}
			local.pipe = null;
			local.loadedModel = "";
			let freed = false;
			try {
				await rm(cacheDir, { recursive: true, force: true });
				freed = true;
			} catch (err) {
				host.log("voice-input deleting the model cache failed:", err);
			}
			try {
				host.storage.delete("whisperModels");
			} catch {
				/* ignore */
			}
			local.progress = null;
			local.phase = "";
			local.error = "";
			res.json({ ok: true, freed });
		});

		/** One local transcription at a time; a second caller is told to wait. */
		async function runLocal(res: VoiceResponse, audio: Buffer, lang: string): Promise<"sent" | "failed"> {
			if (audio.length > MAX_LOCAL_AUDIO_BYTES) {
				res.status(413).json({ error: "the recording is too long (>8 minutes), record it in parts" });
				return "sent";
			}
			if (local.transcribeBusy) {
				res
					.status(429)
					.json({ error: "the local engine is still transcribing the previous clip, retry in a few seconds" });
				return "sent";
			}
			local.transcribeBusy = true;
			try {
				const text = await transcribeLocal(audio, lang);
				res.json({ text, engine: "local" });
				return "sent";
			} finally {
				local.transcribeBusy = false;
			}
		}

		/** Recording -> local or remote -> { text, engine }. */
		const offPost = safe("POST", "/transcribe", async (req, res) => {
			const audio = await readRaw(req);
			if (!audio.length) {
				res.status(400).json({ error: "the request body is empty (no recording arrived)" });
				return;
			}
			const mime = str(req.headers?.["content-type"]).split(";")[0] || "audio/wav";
			const lang = str(req.query?.lang) || str(cfg.lang) || "en-US";
			const eng = engine();
			const remoteUsable = eng !== "local" && remoteReady();
			const route = selectEngine(eng, localReady(), remoteReady());

			if (route === "local-missing") {
				res.status(501).json({
					error: 'local Whisper is not installed yet: click "Install local Whisper" in the microphone overlay',
				});
				return;
			}
			if (route === "local") {
				try {
					await runLocal(res, audio, lang);
					return;
				} catch (err) {
					const status = errorStatus(err);
					// auto only: when the local engine broke and a remote is configured,
					// degrade quietly instead of failing the recording.
					if (eng === "auto" && shouldFallBackToRemote(status, remoteUsable)) {
						host.log("voice-input local transcription failed, falling back to remote:", errorMessage(err));
					} else {
						res.status(status || 502).json({ error: errorMessage(err) });
						return;
					}
				}
			}

			if (!remoteUsable) {
				res.status(501).json({
					error: localReady()
						? "transcription failed: please retry"
						: "no server-side transcription available: either install local Whisper (the button is in the microphone overlay) or configure a remote transcription endpoint in the settings",
				});
				return;
			}
			try {
				const text = await transcribeRemote(audio, mime, lang);
				res.json({ text, engine: "remote" });
			} catch (err) {
				res.status(errorStatus(err) || 502).json({ error: errorMessage(err) });
			}
		});

		host.log("voice-input activated");
		return () => {
			for (const off of [offGet, offStatus, offInstall, offUninstall, offPost]) {
				try {
					off();
				} catch {
					/* ignore */
				}
			}
			try {
				offSettings?.();
			} catch {
				/* ignore */
			}
			host.log("voice-input deactivated");
		};
	},
};
