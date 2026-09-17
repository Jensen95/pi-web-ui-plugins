/**
 * voice-input client - everything behind the microphone button next to the composer.
 *
 * Flow:
 *   The manifest's `ui.composer` slot declares the mic button, which the host renders
 *   next to the composer. Clicking it calls the host's `triggerPluginUiAction`, which
 *   imports this module on demand (the plugin is `view: false`, so it is not loaded
 *   before that). Top-level code registers `onUiAction("voice-input:toggle")`, and that
 *   handler is the real entry point. Recognised text goes into the composer draft
 *   through `window.__piWebUiHost.compose({ text })`; the user still sends it.
 *
 * Recognition strategy, in order:
 *   1. Web Speech API when the browser has it (Chrome/Edge): free, live, local.
 *   2. Otherwise record here and transcribe on the server: an AudioWorklet captures
 *      16 kHz mono PCM, this module encodes a 16-bit WAV (so the server needs no
 *      ffmpeg) and POSTs it to /plugins-api/voice-input/transcribe.
 *   3. When neither is usable, a popover offers the one-click local Whisper install
 *      with progress polling, and starts recording once it is ready.
 *
 * Common failures worth naming, because they all look like "the mic does nothing":
 *   - The page was opened over http://<LAN-IP>, which is not a secure context, so the
 *     browser disables both speech recognition and getUserMedia. Use localhost.
 *   - Browser speech recognition needs the network; a proxy, VPN or enterprise policy
 *     can block it (error code `network`).
 *   - The microphone permission was denied (error code `not-allowed`).
 *
 * Structure: every piece of logic that can be decided without a browser is an exported
 * pure helper at the top of this file (WAV encoding, resampling, engine selection,
 * response parsing, progress formatting) and is covered by
 * tests/unit/voice-input-client.test.ts. Everything below the helpers touches browser
 * APIs and is written so importing this module outside a browser cannot throw.
 */

/** The UI action id the manifest's composer button triggers. */
export const ACTION = "voice-input:toggle";
/** Stop recording after 5 minutes (16 kHz mono WAV is about 9.6 MB by then). */
export const MAX_RECORD_MS = 5 * 60 * 1000;
/** How often the browser may silently restart after a silence cut before giving up. */
export const MAX_SR_RESTARTS = 2;
/** The sample rate the server expects, and what this client resamples to. */
export const TARGET_SAMPLE_RATE = 16000;

export const MESSAGES = {
	listening: "Listening... (click the mic again to finish)",
	recording: "Recording... (click the mic again to transcribe)",
	uploading: "Transcribing...",
	done: "Done",
	cancel: "Cancel",
	close: "Close",
	copy: "Copy",
	useServer: "Use server recording",
	installLocal: "Install local Whisper",
	retry: "Retry",
	installDone: "Installed, start speaking",
	installFailed: "Install failed",
	noSpeech: "Browser recognition unavailable",
	serverMissing: "No server transcription: local Whisper is not installed and no remote endpoint is configured",
	empty: "Did not catch that, please try again",
	insecure:
		"This page is not a secure context (opened over http://LAN-IP?): the browser disables speech recognition and the microphone. Reopen the site over http://localhost or http://127.0.0.1 and try again.",
	micDenied:
		"Microphone denied: click the lock or mic icon left of the address bar, allow the microphone for this site, then retry.",
	srNetwork:
		"Browser speech service unreachable (recognition needs internet; a proxy, VPN or enterprise policy can block it). Switched to server recording, or check the network and retry.",
	srNoSpeech:
		"The browser stopped hearing audio (silence timeout or no mic signal). Speak closer, or use server recording.",
	srBusy: "Browser recognition is busy (another tab may hold it). Wait a few seconds and click the mic again.",
	tooShort: "Recording too short, please finish a sentence.",
	tooLong: "Over 5 minutes, recording finished automatically. Transcribing...",
	recorderBroken:
		"This browser cannot record (AudioContext or getUserMedia unavailable, most likely an insecure context). Reopen the site over localhost.",
	composeFailed: "The composer is not ready, copy the text instead.",
	installNote:
		"Local Whisper is free, needs no key, and the audio never leaves this machine. The first install downloads roughly 150-300 MB (model plus runtime); closing this panel keeps it installing in the background.",
} as const;

/** Public settings the plugin server exposes at GET /settings (never secrets). */
export interface VoiceSettings {
	lang: string;
	serverFallback: boolean;
	engine: string;
	localModel: string;
	serverReady: boolean;
	localReady: boolean;
}

export const DEFAULT_SETTINGS: VoiceSettings = {
	lang: "en-US",
	serverFallback: true,
	engine: "auto",
	localModel: "base",
	serverReady: false,
	localReady: false,
};

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Tolerant parse of GET /settings: any missing or wrong-typed field falls back. */
export function normalizeSettings(raw: unknown): VoiceSettings {
	const d = asRecord(raw);
	return {
		lang: asText(d.lang, DEFAULT_SETTINGS.lang),
		serverFallback: d.serverFallback !== false,
		engine: asText(d.engine, DEFAULT_SETTINGS.engine),
		localModel: asText(d.localModel, DEFAULT_SETTINGS.localModel),
		serverReady: d.serverReady === true,
		localReady: d.localReady === true,
	};
}

/** Server recording needs the fallback switch on and at least one backend ready. */
export function serverUsable(cfg: VoiceSettings | null | undefined): boolean {
	if (!cfg || cfg.serverFallback === false) return false;
	return Boolean(cfg.localReady || cfg.serverReady);
}

export type Engine = "browser" | "server" | "install";

/**
 * Which path a click should take: browser recognition when available and not
 * explicitly overridden, server recording when it is ready, otherwise the install
 * popover.
 */
export function selectEngine(cfg: VoiceSettings | null | undefined, browserRecognition: boolean): Engine {
	const preference = cfg?.engine ?? "auto";
	if (preference === "server") return serverUsable(cfg) ? "server" : "install";
	if (preference === "browser") return browserRecognition ? "browser" : serverUsable(cfg) ? "server" : "install";
	if (browserRecognition) return "browser";
	return serverUsable(cfg) ? "server" : "install";
}

export type SrErrorKind = "denied" | "network" | "nospeech" | "aborted" | "unsupported" | "busy" | "other";

/** Map a SpeechRecognition error code onto a message and a kind the caller branches on. */
export function srExplain(code: unknown): { message: string; kind: SrErrorKind } {
	const c = String(code ?? "");
	if (c === "not-allowed" || c === "service-not-allowed") return { message: MESSAGES.micDenied, kind: "denied" };
	if (c === "network") return { message: MESSAGES.srNetwork, kind: "network" };
	if (c === "no-speech" || c === "audio-capture") return { message: MESSAGES.srNoSpeech, kind: "nospeech" };
	if (c === "audio-busy") return { message: MESSAGES.srBusy, kind: "busy" };
	if (c === "aborted") return { message: MESSAGES.empty, kind: "aborted" };
	if (c === "language-not-supported") return { message: MESSAGES.noSpeech, kind: "unsupported" };
	return { message: `${MESSAGES.noSpeech} (${c || "unknown"})`, kind: "other" };
}

/** Derive the plugin's server base from this module's URL, so a reverse proxy on a
 *  sub-path still resolves. A non-http module URL (a test, a file:// import) gives the
 *  relative base instead of an origin of "null". */
export function apiBaseFrom(moduleUrl: string): string {
	try {
		const u = new URL(moduleUrl);
		if (u.protocol !== "http:" && u.protocol !== "https:") return "/plugins-api/voice-input";
		const i = u.pathname.indexOf("/plugins/");
		const prefix = i >= 0 ? u.pathname.slice(0, i) : "";
		return `${u.origin}${prefix}/plugins-api/voice-input`;
	} catch {
		return "/plugins-api/voice-input";
	}
}

/** mm:ss for the overlay timer. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
	const mm = String(Math.floor(total / 60)).padStart(2, "0");
	const ss = String(total % 60).padStart(2, "0");
	return `${mm}:${ss}`;
}

export interface InstallProgress {
	state: "installing" | "ready" | "error" | "unknown";
	label: string;
	error?: string;
}

/** Tolerant parse of GET /local-status into what the popover shows. */
export function formatInstallProgress(raw: unknown): InstallProgress {
	const d = asRecord(raw);
	if (typeof d.error === "string" && d.error.trim()) {
		return { state: "error", label: `${MESSAGES.installFailed}: ${d.error.trim()}`, error: d.error.trim() };
	}
	if (d.installing === true) {
		const pct = typeof d.progress === "number" && Number.isFinite(d.progress) ? `${Math.round(d.progress)}%` : "";
		const phase = typeof d.phase === "string" && d.phase.trim() ? `(${d.phase.trim()})` : "";
		const detail = `${pct} ${phase}`.trim();
		return {
			state: "installing",
			label: detail ? `Installing local Whisper... ${detail}` : "Installing local Whisper...",
		};
	}
	if (d.ready === true) return { state: "ready", label: MESSAGES.installDone };
	return { state: "unknown", label: MESSAGES.installFailed };
}

/** Tolerant parse of POST /transcribe. Throws with the server's message when it failed. */
export function parseTranscribeResponse(status: number, raw: unknown): string {
	const d = asRecord(raw);
	if (status < 200 || status >= 300) {
		const message = typeof d.error === "string" && d.error.trim() ? d.error.trim() : `transcribe ${status}`;
		throw Object.assign(new Error(message), { status });
	}
	return typeof d.text === "string" ? d.text.trim() : "";
}

/* ---------------- audio helpers (pure) ---------------- */

/** Join the time-ordered blocks the worklet pushes (128 frames each) end to end. */
export function concatSamples(blocks: readonly Float32Array[]): Float32Array {
	let total = 0;
	for (const b of blocks) total += b.length;
	const out = new Float32Array(total);
	let offset = 0;
	for (const b of blocks) {
		out.set(b, offset);
		offset += b.length;
	}
	return out;
}

/** Average channels into mono. This is a per-sample mix, not a time-axis join. */
export function downmixChannels(channels: readonly Float32Array[]): Float32Array {
	if (!channels.length) return new Float32Array(0);
	const first = channels[0];
	if (channels.length === 1 && first) return first.slice();
	let len = 0;
	for (const c of channels) len = Math.max(len, c.length);
	const out = new Float32Array(len);
	for (const c of channels) for (let i = 0; i < c.length; i++) out[i] += c[i]! / channels.length;
	return out;
}

/** Linear resample to 16 kHz, matching what the server decodes, to cut upload size. */
export function resampleTo16k(samples: Float32Array, fromRate: number): Float32Array {
	if (!samples.length) return samples.slice();
	const rate = Math.round(fromRate) || TARGET_SAMPLE_RATE;
	if (rate === TARGET_SAMPLE_RATE) return samples.slice();
	const outLen = Math.max(1, Math.round((samples.length * TARGET_SAMPLE_RATE) / rate));
	const out = new Float32Array(outLen);
	const ratio = samples.length / outLen;
	for (let i = 0; i < outLen; i++) {
		const pos = i * ratio;
		const i0 = Math.floor(pos);
		const i1 = Math.min(i0 + 1, samples.length - 1);
		const f = pos - i0;
		out[i] = samples[i0]! * (1 - f) + samples[i1]! * f;
	}
	return out;
}

/** Mono Float32 samples to a 16-bit PCM WAV file (44-byte canonical header). */
export function encodeWav(mono: Float32Array, sampleRate: number): Uint8Array {
	const sr = Math.floor(sampleRate) || TARGET_SAMPLE_RATE;
	const n = mono.length;
	const buffer = new ArrayBuffer(44 + n * 2);
	const view = new DataView(buffer);
	const writeText = (offset: number, text: string): void => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	writeText(0, "RIFF");
	view.setUint32(4, 36 + n * 2, true);
	writeText(8, "WAVE");
	writeText(12, "fmt ");
	view.setUint32(16, 16, true); // PCM chunk size
	view.setUint16(20, 1, true); // format: PCM
	view.setUint16(22, 1, true); // channels: mono
	view.setUint32(24, sr, true);
	view.setUint32(28, sr * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeText(36, "data");
	view.setUint32(40, n * 2, true);
	for (let i = 0; i < n; i++) {
		const s = Math.max(-1, Math.min(1, mono[i]!));
		view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
	}
	return new Uint8Array(buffer);
}

/* ---------------- speech recognition result parsing (pure) ---------------- */

export interface SpeechResultLike {
	isFinal?: boolean;
	0?: { transcript?: unknown };
}

export interface SpeechResultEventLike {
	resultIndex?: number;
	results?: ArrayLike<SpeechResultLike>;
}

/** Fold one `onresult` event into the running final text plus the interim tail. */
export function collectTranscript(
	event: SpeechResultEventLike,
	previousFinal: string,
): { final: string; interim: string } {
	const results = event.results;
	let final = previousFinal;
	let interim = "";
	if (!results) return { final, interim };
	const start = typeof event.resultIndex === "number" ? event.resultIndex : 0;
	for (let i = start; i < results.length; i++) {
		const result = results[i];
		const transcript = typeof result?.[0]?.transcript === "string" ? result[0].transcript : "";
		if (!transcript) continue;
		if (result?.isFinal) final += transcript;
		else interim += transcript;
	}
	return { final, interim };
}

/* ================================================================== */
/* Browser plumbing below. Every global access is guarded so importing */
/* this module in node (vitest runs without a DOM) cannot throw.       */
/* ================================================================== */

interface HostApi {
	compose?: (options: { text: string }) => boolean;
	onUiAction?: (action: string, handler: () => void) => void;
}

type HostWindow = Window & typeof globalThis & { __piWebUiHost?: HostApi };

function browserWindow(): HostWindow | null {
	try {
		const w = (globalThis as { window?: HostWindow }).window;
		return w && typeof w.document === "object" ? w : null;
	} catch {
		return null;
	}
}

function hostApi(): HostApi | null {
	try {
		return browserWindow()?.__piWebUiHost ?? null;
	} catch {
		return null;
	}
}

const API_BASE = apiBaseFrom(import.meta.url);

let settingsCache: VoiceSettings | null = null;
let settingsAt = 0;

async function getSettings(): Promise<VoiceSettings> {
	if (settingsCache && Date.now() - settingsAt < 60_000) return settingsCache;
	const response = await fetch(`${API_BASE}/settings`, { credentials: "same-origin" });
	if (!response.ok) throw new Error(`settings ${response.status}`);
	settingsCache = normalizeSettings(await response.json().catch(() => ({})));
	settingsAt = Date.now();
	return settingsCache;
}

/* ---------------- overlay (recording state, text, buttons) ---------------- */

interface OverlayButton {
	label: string;
	primary?: boolean;
	onClick: () => void;
}

interface Overlay {
	setStatus(text: string): void;
	setText(text: string, isError?: boolean): void;
	setNote(text: string): void;
	setButtons(buttons: readonly OverlayButton[]): void;
}

const OVERLAY_CSS = `
.vi-overlay {
	position: fixed; left: 50%; bottom: 132px; transform: translateX(-50%);
	z-index: 9999; min-width: 300px; max-width: min(560px, 92vw);
	background: var(--bg-elev, #16161d); color: inherit;
	border: 1px solid var(--border, #333); border-radius: 12px;
	padding: 12px 14px; font-size: 13px;
	box-shadow: 0 8px 32px rgba(0,0,0,.45);
}
.vi-row { display: flex; align-items: center; gap: 8px; }
.vi-dot { width: 10px; height: 10px; border-radius: 50%; background: #e5484d; flex: none;
	animation: vi-pulse 1.2s ease-in-out infinite; }
@keyframes vi-pulse { 50% { opacity: .25; } }
.vi-status { opacity: .75; }
.vi-time { margin-left: auto; opacity: .55; font-variant-numeric: tabular-nums; }
.vi-text { margin: 8px 0 10px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; line-height: 1.6; }
.vi-text:empty { display: none; }
.vi-btns { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.vi-btns button { border: 1px solid var(--border, #333); border-radius: 6px;
	background: transparent; color: inherit; font: inherit; padding: 5px 14px; cursor: pointer; }
.vi-btns button:disabled { opacity: .45; cursor: default; }
.vi-btns .primary { background: var(--accent, #7c5cff); border-color: transparent; color: #fff; }
.vi-err { color: #e5484d; }
.vi-note { opacity: .65; font-size: 12px; margin: 6px 0 2px; line-height: 1.6; }
`;

let overlayRoot: HTMLElement | null = null;

function closeOverlay(): void {
	try {
		overlayRoot?.remove();
	} catch {
		/* ignore */
	}
	overlayRoot = null;
}

/** Build the popover. Returns null outside a browser, so every caller stays safe. */
function openOverlay(): Overlay | null {
	const win = browserWindow();
	if (!win) return null;
	closeOverlay();
	const doc = win.document;
	const make = (tag: string, className: string): HTMLElement => {
		const el = doc.createElement(tag);
		el.className = className;
		return el;
	};
	const root = make("div", "vi-overlay");
	const style = doc.createElement("style");
	style.textContent = OVERLAY_CSS;
	const row = make("div", "vi-row");
	const statusEl = make("span", "vi-status");
	const timeEl = make("span", "vi-time");
	row.append(make("span", "vi-dot"), statusEl, timeEl);
	const textEl = make("div", "vi-text");
	const noteEl = make("div", "vi-note");
	noteEl.style.display = "none";
	const btnsEl = make("div", "vi-btns");
	root.append(style, row, textEl, noteEl, btnsEl);
	doc.body.append(root);
	overlayRoot = root;
	const startedAt = Date.now();
	const timer = win.setInterval(() => {
		if (!overlayRoot) {
			win.clearInterval(timer);
			return;
		}
		if (timeEl) timeEl.textContent = formatElapsed(Date.now() - startedAt);
	}, 500);
	return {
		setStatus(text) {
			if (statusEl) statusEl.textContent = text;
		},
		setText(text, isError = false) {
			if (!textEl) return;
			textEl.textContent = text;
			textEl.classList.toggle("vi-err", isError);
		},
		setNote(text) {
			if (!noteEl) return;
			noteEl.style.display = text ? "" : "none";
			noteEl.textContent = text;
		},
		setButtons(buttons) {
			if (!btnsEl) return;
			btnsEl.textContent = "";
			for (const button of buttons) {
				const el = doc.createElement("button");
				el.type = "button";
				el.textContent = button.label;
				if (button.primary) el.className = "primary";
				el.addEventListener("click", button.onClick);
				btnsEl.append(el);
			}
		},
	};
}

/* ---------------- session state machine: idle | sr | rec ---------------- */

interface RecognitionLike {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	start(): void;
	stop(): void;
	abort(): void;
	onresult: ((event: SpeechResultEventLike) => void) | null;
	onerror: ((event: { error?: unknown }) => void) | null;
	onend: (() => void) | null;
}

interface CaptureResult {
	samples: Float32Array;
	empty?: boolean;
}

interface CaptureHandle {
	stop(manual: boolean): CaptureResult | null;
	cleanup(): void;
}

const session = {
	mode: "idle" as "idle" | "sr" | "rec",
	recognition: null as RecognitionLike | null,
	capture: null as CaptureHandle | null,
	finalText: "",
	manualStop: false,
	/** Set while switching to server recording, so the abort-triggered onend/onerror
	 *  does not also finish the half-heard browser text. */
	switching: false,
	srRestarts: 0,
};

function resetSession(): void {
	try {
		session.recognition?.abort();
	} catch {
		/* ignore */
	}
	try {
		session.capture?.cleanup();
	} catch {
		/* ignore */
	}
	session.mode = "idle";
	session.recognition = null;
	session.capture = null;
	session.finalText = "";
	session.manualStop = false;
	session.switching = false;
	session.srRestarts = 0;
}

/** Put the text in the composer draft; if that fails, offer a copy button so no text is lost. */
async function finishWithText(text: string): Promise<void> {
	const value = String(text ?? "").trim();
	resetSession();
	if (!value) {
		const ui = openOverlay();
		ui?.setStatus("Voice input");
		ui?.setText(MESSAGES.empty, true);
		ui?.setButtons([{ label: MESSAGES.close, primary: true, onClick: closeOverlay }]);
		browserWindow()?.setTimeout(closeOverlay, 2500);
		return;
	}
	const composed = (() => {
		try {
			return hostApi()?.compose?.({ text: value }) !== false;
		} catch {
			return false;
		}
	})();
	if (composed && typeof hostApi()?.compose === "function") {
		closeOverlay();
		return;
	}
	const ui = openOverlay();
	ui?.setStatus("Voice input");
	ui?.setText(value);
	ui?.setNote(MESSAGES.composeFailed);
	ui?.setButtons([
		{
			label: MESSAGES.copy,
			primary: true,
			onClick: () => {
				try {
					void browserWindow()?.navigator?.clipboard?.writeText(value);
				} catch {
					/* ignore */
				}
				closeOverlay();
			},
		},
		{ label: MESSAGES.close, onClick: closeOverlay },
	]);
}

function showError(message: string, note = ""): void {
	resetSession();
	const ui = openOverlay();
	ui?.setStatus("Voice input");
	ui?.setText(message, true);
	if (note) ui?.setNote(note);
	ui?.setButtons([{ label: MESSAGES.close, primary: true, onClick: closeOverlay }]);
}

/* ---------------- browser recognition (Web Speech API) ---------------- */

function recognitionCtor(): (new () => RecognitionLike) | null {
	const win = browserWindow() as (HostWindow & Record<string, unknown>) | null;
	if (!win) return null;
	const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
	return typeof ctor === "function" ? (ctor as new () => RecognitionLike) : null;
}

export function browserRecognitionSupported(): boolean {
	try {
		return recognitionCtor() !== null;
	} catch {
		return false;
	}
}

function startSpeechRecognition(cfg: VoiceSettings): void {
	const Ctor = recognitionCtor();
	if (!Ctor) {
		if (serverUsable(cfg)) void startRecorderFlow();
		else showInstallPrompt(MESSAGES.noSpeech);
		return;
	}
	const recognition = new Ctor();
	recognition.lang = cfg.lang || DEFAULT_SETTINGS.lang;
	recognition.continuous = true;
	recognition.interimResults = true;
	resetSession();
	session.recognition = recognition;
	session.mode = "sr";
	const ui = openOverlay();
	ui?.setStatus(`Voice input - ${MESSAGES.listening}`);

	const switchToServer = (): void => {
		// Raise the flag before aborting: the abort-triggered onend must not finish the
		// half-heard text, otherwise the user sees both the text and a new recording.
		session.switching = true;
		session.manualStop = true;
		session.finalText = "";
		try {
			recognition.abort();
		} catch {
			/* ignore */
		}
		void startRecorderFlow();
	};

	const buttons: OverlayButton[] = [
		{ label: MESSAGES.done, primary: true, onClick: () => void finishWithText(session.finalText) },
		{
			label: MESSAGES.cancel,
			onClick: () => {
				resetSession();
				closeOverlay();
			},
		},
	];
	if (serverUsable(cfg)) buttons.splice(1, 0, { label: MESSAGES.useServer, onClick: switchToServer });
	ui?.setButtons(buttons);

	recognition.onresult = (event) => {
		const { final, interim } = collectTranscript(event, session.finalText);
		session.finalText = final;
		ui?.setText(`${final}${interim}`.trim());
	};

	recognition.onerror = (event) => {
		if (session.mode !== "sr") return;
		if (session.switching) return;
		if (event?.error === "aborted" && session.manualStop) return;
		const info = srExplain(event?.error);
		// Permission problems do not get better by retrying.
		if (info.kind === "denied") {
			showError(info.message);
			return;
		}
		if (info.kind === "busy") {
			showError(MESSAGES.srBusy);
			return;
		}
		if (serverUsable(cfg)) {
			session.switching = true;
			try {
				recognition.abort();
			} catch {
				/* ignore */
			}
			ui?.setStatus(`Voice input - ${info.message}`);
			browserWindow()?.setTimeout(() => {
				if (session.mode === "sr") void startRecorderFlow();
			}, 600);
			return;
		}
		showInstallPrompt(info.message);
	};

	recognition.onend = () => {
		// Done/Cancel/Switch already reset the session; do not resurrect it.
		if (session.mode !== "sr") return;
		if (session.switching) {
			// Text that was already recognised wins over the pending switch.
			if (session.finalText.trim()) void finishWithText(session.finalText);
			return;
		}
		if (session.manualStop || session.finalText.trim()) {
			void finishWithText(session.finalText);
			return;
		}
		if (session.srRestarts >= MAX_SR_RESTARTS) {
			if (serverUsable(cfg)) void startRecorderFlow();
			else showInstallPrompt(MESSAGES.srNoSpeech);
			return;
		}
		session.srRestarts++;
		try {
			recognition.start();
		} catch {
			if (serverUsable(cfg)) void startRecorderFlow();
			else showInstallPrompt(MESSAGES.noSpeech);
		}
	};

	try {
		recognition.start();
	} catch {
		if (serverUsable(cfg)) void startRecorderFlow();
		else showInstallPrompt(MESSAGES.noSpeech);
	}
}

/* ---------------- server recording: capture, WAV, transcribe ---------------- */

const WORKLET_SOURCE = `
class ViCap extends AudioWorkletProcessor {
	process(inputs) {
		const ch = inputs && inputs[0];
		if (ch && ch.length) {
			const copy = [];
			for (let i = 0; i < ch.length; i++) copy.push(ch[i].slice(0));
			this.port.postMessage(copy);
		}
		return true;
	}
}
registerProcessor('vi-cap', ViCap);
`;

/**
 * Capture one take of 16 kHz mono PCM. AudioWorklet first, ScriptProcessor as the
 * fallback. Rejects with a human-readable message when the browser cannot record.
 */
function capturePcm16k(onAutoStop: (samples: Float32Array) => void): Promise<CaptureHandle> {
	return new Promise((resolve, reject) => {
		const win = browserWindow() as (HostWindow & Record<string, unknown>) | null;
		if (!win) {
			reject(new Error(MESSAGES.recorderBroken));
			return;
		}
		let stream: MediaStream | null = null;
		let ctx: AudioContext | null = null;
		let node: AudioNode | null = null;
		let source: AudioNode | null = null;
		let workletUrl: string | null = null;
		const chunks: Float32Array[] = [];
		let sampleRate = TARGET_SAMPLE_RATE;
		let settled = false;
		let autoTimer = 0;

		const cleanup = (): void => {
			try {
				if (autoTimer) win.clearTimeout(autoTimer);
				(node as { disconnect?: () => void } | null)?.disconnect?.();
				(source as { disconnect?: () => void } | null)?.disconnect?.();
				void ctx?.close();
				stream?.getTracks().forEach((track) => track.stop());
				if (workletUrl) URL.revokeObjectURL(workletUrl);
			} catch {
				/* ignore */
			}
		};

		const finish = (manual: boolean): CaptureResult | null => {
			if (settled) return null;
			settled = true;
			// chunks are time slices and must be concatenated; downmixChannels averages
			// channels and would collapse the whole take into a few samples.
			const samples = resampleTo16k(concatSamples(chunks), sampleRate);
			cleanup();
			if (!manual) return { samples };
			return samples.length ? { samples } : { samples, empty: true };
		};

		void (async () => {
			try {
				const media = win.navigator?.mediaDevices;
				if (!media?.getUserMedia) throw new Error("gum-missing");
				stream = await media.getUserMedia({ audio: true });
			} catch {
				reject(new Error(MESSAGES.micDenied));
				return;
			}
			try {
				const AC = (win.AudioContext ?? win.webkitAudioContext) as
					(new (options?: unknown) => AudioContext) | undefined;
				if (!AC) throw new Error("no-audio-context");
				try {
					ctx = new AC({ sampleRate: TARGET_SAMPLE_RATE });
				} catch {
					ctx = new AC();
				}
				sampleRate = ctx.sampleRate || TARGET_SAMPLE_RATE;
			} catch {
				try {
					stream.getTracks().forEach((track) => track.stop());
				} catch {
					/* ignore */
				}
				reject(new Error(MESSAGES.recorderBroken));
				return;
			}
			const audioCtx = ctx;
			source = audioCtx.createMediaStreamSource(stream);
			autoTimer = win.setTimeout(() => {
				const result = finish(true);
				if (result) {
					try {
						onAutoStop(result.samples);
					} catch {
						/* ignore */
					}
				}
			}, MAX_RECORD_MS);

			/** Some browsers only run a node that reaches the destination; a zero-gain
			 *  node keeps it running without making any sound. */
			const groundThroughSilence = (from: AudioNode): void => {
				try {
					const zero = audioCtx.createGain();
					zero.gain.value = 0;
					from.connect(zero);
					zero.connect(audioCtx.destination);
				} catch {
					/* ignore */
				}
			};

			try {
				workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
				await audioCtx.audioWorklet.addModule(workletUrl);
				const workletNode = new AudioWorkletNode(audioCtx, "vi-cap");
				node = workletNode;
				workletNode.port.onmessage = (event: MessageEvent<unknown>) => {
					const data = event.data;
					if (Array.isArray(data) && data.length) {
						chunks.push(downmixChannels(data.map((c) => Float32Array.from(c as ArrayLike<number>))));
					}
				};
				source.connect(workletNode);
				groundThroughSilence(workletNode);
			} catch {
				// Fallback: ScriptProcessor is deprecated but available everywhere.
				try {
					const processor = audioCtx.createScriptProcessor(4096, 1, 1);
					node = processor;
					processor.onaudioprocess = (event) => {
						try {
							chunks.push(event.inputBuffer.getChannelData(0).slice(0));
						} catch {
							/* ignore */
						}
					};
					source.connect(processor);
					groundThroughSilence(processor);
				} catch {
					cleanup();
					reject(new Error(MESSAGES.recorderBroken));
					return;
				}
			}
			resolve({
				stop: finish,
				cleanup: () => {
					if (!settled) {
						settled = true;
						cleanup();
					}
				},
			});
		})();
	});
}

async function startRecorderFlow(): Promise<void> {
	let cfg: VoiceSettings;
	try {
		cfg = await getSettings();
	} catch {
		showInstallPrompt(MESSAGES.serverMissing);
		return;
	}
	if (!serverUsable(cfg)) {
		showInstallPrompt(MESSAGES.serverMissing);
		return;
	}
	resetSession();
	session.mode = "rec";
	const ui = openOverlay();
	ui?.setStatus(`Voice input - ${MESSAGES.recording}`);
	ui?.setButtons([
		{
			label: MESSAGES.done,
			primary: true,
			onClick: () => {
				session.manualStop = true;
				try {
					const result = session.capture?.stop(true);
					if (result) void handleRecorded(result.samples, cfg, false);
				} catch {
					resetSession();
					closeOverlay();
				}
			},
		},
		{
			label: MESSAGES.cancel,
			onClick: () => {
				resetSession();
				closeOverlay();
			},
		},
	]);
	try {
		const capture = await capturePcm16k((samples) => {
			// The 5-minute auto stop already settled the capture; go straight to upload.
			if (session.mode === "rec") {
				session.manualStop = true;
				void handleRecorded(samples, cfg, true);
			}
		});
		if (session.mode !== "rec") {
			// The user cancelled while the permission prompt was up.
			capture.cleanup();
			return;
		}
		session.capture = capture;
	} catch (error) {
		showError(error instanceof Error ? error.message : String(error));
	}
}

async function handleRecorded(samples: Float32Array, cfg: VoiceSettings, timedOut: boolean): Promise<void> {
	resetSession();
	if (!samples || !samples.length) {
		const ui = openOverlay();
		ui?.setStatus("Voice input");
		ui?.setText(MESSAGES.tooShort, true);
		ui?.setButtons([{ label: MESSAGES.close, primary: true, onClick: closeOverlay }]);
		browserWindow()?.setTimeout(closeOverlay, 2500);
		return;
	}
	const ui = openOverlay();
	ui?.setStatus(`Voice input - ${timedOut ? MESSAGES.tooLong : MESSAGES.uploading}`);
	ui?.setButtons([
		{
			label: MESSAGES.cancel,
			onClick: () => {
				resetSession();
				closeOverlay();
			},
		},
	]);
	let text = "";
	try {
		const wav = encodeWav(samples, TARGET_SAMPLE_RATE);
		const response = await fetch(
			`${API_BASE}/transcribe?lang=${encodeURIComponent(cfg.lang || DEFAULT_SETTINGS.lang)}`,
			{
				method: "POST",
				headers: { "Content-Type": "audio/wav" },
				body: new Blob([wav as BlobPart], { type: "audio/wav" }),
				credentials: "same-origin",
			},
		);
		text = parseTranscribeResponse(response.status, await response.json().catch(() => ({})));
	} catch (error) {
		const status = (error as { status?: number })?.status ?? 0;
		// 501 means neither backend is usable: offer the install instead of a bare error.
		if (status === 501) {
			showInstallPrompt(error instanceof Error ? error.message : String(error));
			return;
		}
		showError(error instanceof Error ? error.message : String(error));
		return;
	}
	await finishWithText(text);
}

/* ---------------- one-click local Whisper install ---------------- */

function showInstallPrompt(why: string): void {
	resetSession();
	const ui = openOverlay();
	ui?.setStatus("Voice input");
	ui?.setText(why || MESSAGES.serverMissing);
	ui?.setNote(MESSAGES.installNote);
	ui?.setButtons([
		{ label: MESSAGES.installLocal, primary: true, onClick: () => void runLocalInstall() },
		{ label: MESSAGES.close, onClick: closeOverlay },
	]);
}

async function runLocalInstall(): Promise<void> {
	const win = browserWindow();
	const ui = openOverlay();
	if (!ui || !win) return;
	ui.setStatus("Voice input - Installing local Whisper...");
	ui.setNote(MESSAGES.installNote);
	// Closing the panel mid-install keeps the server task running.
	ui.setButtons([{ label: MESSAGES.close, onClick: closeOverlay }]);
	const failed = (message: string): void => {
		ui.setStatus("Voice input");
		ui.setText(`${MESSAGES.installFailed}: ${message}`, true);
		ui.setButtons([
			{ label: MESSAGES.retry, primary: true, onClick: () => void runLocalInstall() },
			{ label: MESSAGES.close, onClick: closeOverlay },
		]);
	};
	try {
		const response = await fetch(`${API_BASE}/local-install`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
			credentials: "same-origin",
		});
		const data = asRecord(await response.json().catch(() => ({})));
		if (!response.ok && response.status !== 202) {
			throw new Error(typeof data.error === "string" ? data.error : `local-install ${response.status}`);
		}
	} catch (error) {
		failed(error instanceof Error ? error.message : String(error));
		return;
	}
	// Poll for progress. Closing the overlay stops polling, not the install.
	const timer = win.setInterval(() => {
		if (!overlayRoot) {
			win.clearInterval(timer);
			return;
		}
		void (async () => {
			let status: unknown;
			try {
				const response = await fetch(`${API_BASE}/local-status`, { credentials: "same-origin" });
				if (!response.ok) return;
				status = await response.json();
			} catch {
				return;
			}
			const progress = formatInstallProgress(status);
			if (progress.state === "installing") {
				ui.setStatus(`Voice input - ${progress.label}`);
				return;
			}
			win.clearInterval(timer);
			if (!overlayRoot) return;
			if (progress.state === "error") {
				failed(progress.error ?? MESSAGES.installFailed);
				return;
			}
			if (progress.state === "ready") {
				settingsAt = 0; // drop the cache so localReady is re-read
				ui.setStatus(`Voice input - ${progress.label}`);
				ui.setText("");
				ui.setNote("");
				win.setTimeout(() => {
					if (overlayRoot) void startRecorderFlow();
				}, 600);
				return;
			}
			ui.setStatus("Voice input");
			ui.setText(progress.label, true);
			ui.setButtons([{ label: MESSAGES.close, primary: true, onClick: closeOverlay }]);
		})();
	}, 1000);
}

/* ---------------- entry point: the composer mic button ---------------- */

function isSecureContext(): boolean {
	try {
		const win = browserWindow();
		if (!win) return true;
		if (typeof win.isSecureContext === "boolean") return win.isSecureContext;
		const protocol = win.location?.protocol;
		return protocol === "https:" || protocol === "wss:" || win.location?.hostname === "localhost";
	} catch {
		return true;
	}
}

async function toggle(): Promise<void> {
	// Clicking while recording means "finish".
	if (session.mode === "sr") {
		session.manualStop = true;
		try {
			session.recognition?.stop();
		} catch {
			void finishWithText(session.finalText);
		}
		return;
	}
	if (session.mode === "rec") {
		session.manualStop = true;
		try {
			const result = session.capture?.stop(true);
			let cfg = DEFAULT_SETTINGS;
			try {
				cfg = await getSettings();
			} catch {
				/* transcribe with the default language */
			}
			// A null result means the auto stop already took over.
			if (result) void handleRecorded(result.samples, cfg, false);
		} catch {
			resetSession();
			closeOverlay();
		}
		return;
	}
	// Outside a secure context the browser disables recognition and the mic entirely.
	if (!isSecureContext()) {
		showError(MESSAGES.insecure);
		return;
	}
	let cfg = DEFAULT_SETTINGS;
	try {
		cfg = await getSettings();
	} catch {
		/* fall back to browser-only mode and report the reason on downgrade */
	}
	const engine = selectEngine(cfg, browserRecognitionSupported());
	if (engine === "browser") startSpeechRecognition(cfg);
	else if (engine === "server") void startRecorderFlow();
	else showInstallPrompt(browserRecognitionSupported() ? MESSAGES.serverMissing : MESSAGES.noSpeech);
}

let registered = false;

/** Register the composer action handler. Idempotent and a no-op outside a browser. */
export function register(): boolean {
	if (registered) return true;
	try {
		const onUiAction = hostApi()?.onUiAction;
		if (typeof onUiAction !== "function") return false;
		onUiAction(ACTION, () => {
			void toggle();
		});
		registered = true;
		return true;
	} catch {
		// An old host is better off with a dead button than a crash.
		return false;
	}
}

register();

/**
 * The host's loader requires `default.mount` to be a function, otherwise the module is
 * marked failed and the first click only registers. This plugin is `view: false` and has
 * nothing to render, so mount only makes sure the action handler is registered.
 */
export default {
	mount(): () => void {
		register();
		return () => {};
	},
};
