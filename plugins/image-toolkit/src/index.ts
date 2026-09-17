// @ts-nocheck
/**
 * image-toolkit server entry — workspace image read/write channel + 4 AI tools.
 *
 * Split of work: the pixel work happens mostly in the **browser** (the 🖼 view uses
 * Canvas: no dependencies, widest format support, it decodes PNG/JPEG/WebP/GIF/AVIF).
 * This file only does the two things the browser cannot:
 *
 *   1. Workspace integration — HTTP routes for the view (host.route, exposed as
 *      /plugins-api/image-toolkit/*): list a directory / read an image (raw bytes,
 *      no base64) / write an image (raw bytes) / read metadata / read the internal
 *      plugin config (GET) + save it (POST). Everything goes through host.fs, so
 *      paths are anchored to the current workspace and escapes are rejected.
 *
 *      The config lives in the plugin's own storage (the "config" key) and is edited
 *      in the ⚙ button at the top right of the 🖼 view — no longer through the host's
 *      declarative manifest settings (the manifest no longer declares any).
 *
 *   2. AI tools — let the agent work on workspace images directly, using the bundled
 *      **pure-JS codecs** (PNG / BMP implemented here, see core/) plus the optional
 *      pure-JS JPEG package jpeg-js (installed once into the plugin directory via
 *      host.ensureDeps; switchable off in the view's ⚙ settings). WebP / GIF / AVIF
 *      pixel work stays in the view; the tools say so instead of failing silently.
 *
 * The four tools: image_info / image_transform / image_compress / image_watermark.
 * All take a single path or a batch of paths, with out / outDir / suffix / overwrite
 * controlling the output names.
 */
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { decodeImage, encodeImage, hasJpegCodec, mimeForFormat, setJpegCodec, sniffFormat } from "./codec.ts";
import { parseExif, probeImage } from "./probe.ts";
import {
	adjustImage,
	compositeOverlay,
	cropImage,
	dominantColors,
	flipImage,
	histogram,
	resizeImage,
	rotateArbitrary,
	rotateImage,
} from "./ops.ts";

/** Recognised image extensions (used when listing directories and scanning for the AI tools). */
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".svg", ".ico"]);

/** Formats the server **can** decode (everything else belongs in the browser). */
const SERVER_DECODE = new Set(["png", "jpeg", "bmp"]);
/** Formats the server **can** encode (quality only means something for jpeg). */
const SERVER_ENCODE = new Set(["png", "jpeg", "bmp"]);

/** Output extension (jpeg → jpg, like most sites and tools). */
const EXT_OF = { jpeg: "jpg", png: "png", bmp: "bmp", webp: "webp", avif: "avif", gif: "gif" };

/** Decoded-pixel ceiling: a stray 200MP image must not eat the service process. */
const MAX_PIXELS = 64_000_000;

const isImageName = (name) => IMAGE_EXT.has(extname(name).toLowerCase());

/** Normalize to a posix-style relative path (the AI often writes a\b.png; ./a.png is tolerated too). */
function normalizeRel(p) {
	return String(p ?? "")
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.trim();
}

/** Human-readable byte size. */
function fmtBytes(n) {
	if (!Number.isFinite(n)) return "?";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Display path: relative to the workspace where possible (shorter and easier to read). */
function pretty(cwd, rel) {
	const abs = resolve(cwd, rel);
	const relToCwd = abs.startsWith(resolve(cwd) + sep) ? abs.slice(resolve(cwd).length + 1) : abs;
	return relToCwd.split(sep).join("/");
}

/** "#rrggbb" / "#rrggbbaa" / [r,g,b,a] → [r,g,b,a] */
function parseColor(c) {
	if (Array.isArray(c)) {
		const [r, g, b, a = 255] = c.map(Number);
		return [r | 0, g | 0, b | 0, a | 0];
	}
	const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(c ?? "").trim());
	if (!m) return null;
	const hex = m[1];
	const a = m[2] ?? "ff";
	return [
		Number.parseInt(hex.slice(0, 2), 16),
		Number.parseInt(hex.slice(2, 4), 16),
		Number.parseInt(hex.slice(4, 6), 16),
		Number.parseInt(a, 16),
	];
}

/** Path list from the tool parameters: path and/or paths, de-duplicated, empties dropped. */
function pathList(params) {
	const raw = [];
	if (typeof params.path === "string" && params.path.trim()) raw.push(params.path);
	if (Array.isArray(params.paths)) for (const p of params.paths) if (typeof p === "string" && p.trim()) raw.push(p);
	const seen = new Set();
	const out = [];
	for (const p of raw) {
		const n = normalizeRel(p);
		if (!n || seen.has(n)) continue;
		seen.add(n);
		out.push(n);
	}
	return out;
}

export default {
	activate(host) {
		/** Internal plugin config (the "config" key in host.storage; edited in the view's ⚙). */
		const DEFAULTS = {
			defaultFormat: "keep",
			quality: 0.82,
			maxDim: 0,
			suffix: "-min",
			overwrite: false,
			aiTools: true,
			allowServerDeps: true,
		};

		/** Normalize before storing: bad values fall back to the default, never to a broken view or tool. */
		function normalizeConfig(raw) {
			const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
			const fmt = String(r.defaultFormat ?? "keep");
			const q = Number(r.quality ?? 0.82);
			const maxDim = Number(r.maxDim ?? 0);
			return {
				defaultFormat: ["keep", "jpeg", "webp", "png", "avif"].includes(fmt) ? fmt : "keep",
				quality: Number.isFinite(q) ? Math.min(1, Math.max(0.1, q)) : 0.82,
				maxDim: Number.isFinite(maxDim) ? Math.min(20000, Math.max(0, Math.round(maxDim))) : 0,
				suffix: typeof r.suffix === "string" ? r.suffix : "-min",
				overwrite: r.overwrite === true,
				aiTools: r.aiTools !== false,
				allowServerDeps: r.allowServerDeps !== false,
			};
		}

		/** Read the config: storage.config wins; when empty, migrate the old declarative ⚙ panel
		 *  settings (the "settings" key in storage.json) once; when that is empty too, use defaults. */
		function loadConfig() {
			let stored = {};
			try {
				stored = host.storage?.get("config", {}) ?? {};
			} catch {
				stored = {};
			}
			if (stored && typeof stored === "object" && !Array.isArray(stored) && Object.keys(stored).length) {
				return normalizeConfig({ ...DEFAULTS, ...stored });
			}
			let legacy = {};
			try {
				legacy = host.getSettings?.() ?? {};
			} catch {
				legacy = {};
			}
			// The manifest no longer declares settings, so getSettings() returns {} — look for the old
			// "settings" key directly in the storage table (same file as storage.config, no conflict).
			if (!legacy || typeof legacy !== "object" || !Object.keys(legacy).length) {
				try {
					const all = host.storage?.all?.() ?? {};
					if (all && typeof all === "object" && all.settings && typeof all.settings === "object") {
						legacy = all.settings;
					}
				} catch {
					/* Unreadable storage just means no legacy values; not fatal. */
				}
			}
			if (legacy && typeof legacy === "object" && Object.keys(legacy).length) {
				const migrated = normalizeConfig({ ...DEFAULTS, ...legacy });
				try {
					host.storage?.set("config", migrated);
				} catch {
					/* If it cannot be stored we migrate again next time; not fatal. */
				}
				host.log("Migrated the old ⚙ panel settings into the internal plugin config");
				return migrated;
			}
			return { ...DEFAULTS };
		}

		let cfg = loadConfig();

		/** Save the config: normalize → persist → broadcast to the view → register/unregister AI tools. */
		function saveConfig(patch) {
			cfg = normalizeConfig({
				...cfg,
				...(patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}),
			});
			try {
				host.storage?.set("config", cfg);
			} catch (err) {
				// The host formats non-string log args with JSON.stringify, and an Error
				// stringifies to "{}" — always log the message text, never the raw value.
				host.log("error", "Saving the config failed:", err instanceof Error ? err.message : String(err));
			}
			host.broadcast({ kind: "settings", values: cfg });
			syncTools();
			return cfg;
		}

		/** AI tool unregister callbacks (used when "let the AI handle images" is switched off). */
		let offTools = [];
		let toolsOn = false;

		// ------------------------------------------------------------------
		// JPEG codec: the pure-JS jpeg-js, installed on first use (inside the plugin dir)
		// ------------------------------------------------------------------
		let jpegTried = false;
		async function ensureJpeg() {
			if (hasJpegCodec()) return true;
			if (cfg.allowServerDeps === false) return false;
			if (jpegTried) return false;
			jpegTried = true;
			try {
				const ok = await host.ensureDeps(["jpeg-js"], {
					onProgress: (m) => host.notify("info", m, m),
				});
				if (!ok) return false;
				const require = createRequire(join(host.dir, "index.mjs"));
				setJpegCodec(require("jpeg-js"));
				host.log("jpeg-js is ready (the server can process JPEG)");
				return true;
			} catch (err) {
				// Degraded but alive: JPEG stays unavailable, every other format still works.
				host.log("warn", "Loading jpeg-js failed:", err instanceof Error ? err.message : String(err));
				return false;
			}
		}

		/** Read + decode a workspace image (unsupported formats get an actionable hint). */
		async function loadImage(rel) {
			const buf = await host.fs.read(rel);
			const format = sniffFormat(buf);
			if (!SERVER_DECODE.has(format)) {
				throw new Error(
					`The server can only process PNG / JPEG / BMP, and this file is ${format}. ` +
						`Handle WebP / GIF / AVIF in the 🖼 Image Toolkit view (browser Canvas supports them), which can also save straight back to the workspace.`,
				);
			}
			if (format === "jpeg" && !(await ensureJpeg())) {
				throw new Error(
					'Processing JPEG needs a one-time install of the pure-JS codec package jpeg-js (enable "Allow installing pure-JS codec packages" in the ⚙ settings at the top right of the 🖼 view and retry, or use PNG).',
				);
			}
			const img = await decodeImage(buf, { maxPixels: MAX_PIXELS });
			return { buf, format, img };
		}

		/** List one directory level (relative to the workspace); shared by the AI scan and the view. */
		async function listDir(relDir) {
			const entries = await host.fs.list(relDir);
			return entries
				.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "__pycache__")
				.map((e) => ({
					name: e.name,
					type: e.type,
					path: relDir ? `${relDir}/${e.name}` : e.name,
					isImage: e.type === "file" && isImageName(e.name),
				}))
				.sort((a, b) => {
					if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
					if (a.isImage !== b.isImage) return a.isImage ? -1 : 1;
					return a.name.localeCompare(b.name);
				});
		}

		/** Recursively scan a directory for images (AI tools only; depth and count are capped). */
		async function scanImages(relDir, depth, acc, depthLimit = 3) {
			const entries = await listDir(relDir).catch(() => []);
			for (const e of entries) {
				if (acc.length >= 200) return acc;
				if (e.type === "dir") {
					if (depth < depthLimit) await scanImages(e.path, depth + 1, acc, depthLimit);
				} else if (e.isImage) {
					acc.push(e.path);
				}
			}
			return acc;
		}

		/** Output path: explicit out > outDir + new name > same directory + suffix; collisions get -1/-2. */
		async function resolveOutPath(rel, ext, o) {
			const suffix = typeof o.suffix === "string" ? o.suffix : String(cfg.suffix ?? "-min");
			const explicit = Boolean(o.out);
			let relOut;
			if (explicit) {
				relOut = normalizeRel(o.out);
			} else {
				const dir = o.outDir ? normalizeRel(o.outDir) : normalizeRel(dirname(rel));
				const base = basename(rel, extname(rel));
				const name = `${base}${suffix}.${ext}`;
				relOut = dir && dir !== "." ? `${dir}/${name}` : name;
			}
			if (o.overwrite || explicit) return relOut;
			const dir = normalizeRel(dirname(relOut));
			const names = new Set((await host.fs.list(dir || "").catch(() => [])).map((e) => e.name));
			const name = basename(relOut);
			if (!names.has(name)) return relOut;
			const stem = basename(name, extname(name));
			const e = extname(name);
			for (let i = 1; i < 1000; i++) {
				const candidate = `${stem}-${i}${e}`;
				if (!names.has(candidate)) return dir && dir !== "." ? `${dir}/${candidate}` : candidate;
			}
			return relOut;
		}

		/** Encode and write to disk; returns a result summary. */
		async function writeImage(img, format, quality, rel, o) {
			if (!SERVER_ENCODE.has(format)) {
				throw new Error(
					`The server can only write PNG / JPEG / BMP, not ${format} (export WebP/AVIF from the 🖼 view).`,
				);
			}
			const buf = await encodeImage(img, format, { quality });
			const relOut = await resolveOutPath(rel, EXT_OF[format] ?? format, o);
			await host.fs.write(relOut, buf);
			return { out: pretty(host.cwd, relOut), outRel: relOut, bytes: buf.length };
		}

		/**
		 * Main per-file pipeline: decode → a chain of geometry/color operations → encode and write.
		 * The return value feeds the tools' text summary and lets a batch report per-file errors
		 * instead of failing as a whole.
		 */
		async function processOne(rel, plan, o) {
			const { buf: srcBuf, format: srcFormat, img: src } = await loadImage(rel);
			let img = src;
			const steps = [];

			// 1) Rotate/flip (geometry first — crop coordinates are in the *rotated* coordinate system)
			if (plan.rotate) {
				img = rotateImage(img, Number(plan.rotate));
				steps.push(`rotate ${Number(plan.rotate)}°`);
			}
			if (plan.flip) {
				img = flipImage(img, String(plan.flip));
				steps.push(`flip ${plan.flip}`);
			}
			if (plan.angle) {
				const bg = parseColor(plan.background) ?? [0, 0, 0, 0];
				img = rotateArbitrary(img, Number(plan.angle), { background: bg });
				steps.push(`arbitrary angle ${Number(plan.angle)}°`);
			}
			// 2) Crop
			if (plan.crop) {
				const c = plan.crop;
				img = cropImage(img, {
					x: Number(c.x ?? 0),
					y: Number(c.y ?? 0),
					width: Number(c.width ?? c.w ?? img.width),
					height: Number(c.height ?? c.h ?? img.height),
				});
				steps.push(`crop ${img.width}×${img.height}`);
			}
			// 3) Resize
			if (plan.resize) {
				const r = plan.resize;
				const before = { w: img.width, h: img.height };
				const target = {};
				if (r.percent) {
					target.width = Math.max(1, Math.round((img.width * Number(r.percent)) / 100));
					target.height = Math.max(1, Math.round((img.height * Number(r.percent)) / 100));
				} else if (r.longEdge) {
					const le = Number(r.longEdge);
					if (img.width >= img.height) {
						target.width = le;
						target.height = Math.max(1, Math.round((img.height * le) / img.width));
					} else {
						target.height = le;
						target.width = Math.max(1, Math.round((img.width * le) / img.height));
					}
				} else {
					target.width = r.width ? Number(r.width) : undefined;
					target.height = r.height ? Number(r.height) : undefined;
				}
				// No upscaling: keep the source when the target is larger. Exception: when width *and*
				// height are given explicitly the caller clearly wants that exact size, so allow it.
				const willUp = (target.width ?? img.width) > img.width || (target.height ?? img.height) > img.height;
				const exactBoth = Boolean(r.width && r.height);
				if (r.noUpscale === false || exactBoth || !willUp) {
					img = resizeImage(img, target);
					steps.push(`resize ${before.w}×${before.h} → ${img.width}×${img.height}`);
				}
			}
			// 4) Color/filters
			if (plan.adjust && Object.keys(plan.adjust).length) {
				img = adjustImage(img, plan.adjust);
				steps.push(`filters ${Object.keys(plan.adjust).join("/")}`);
			}

			// 5) Watermark (image overlay: its path is relative to the workspace too)
			if (plan.watermarkPath) {
				const wmRel = normalizeRel(plan.watermarkPath);
				const { img: wm } = await loadImage(wmRel);
				const position = String(plan.position ?? "br");
				const opacity = plan.opacity === undefined ? 0.8 : Number(plan.opacity);
				const scale = plan.scale === undefined ? 1 : Number(plan.scale);
				const margin = Number(plan.margin ?? 0);
				const w = Math.max(1, Math.round(wm.width * scale));
				const h = Math.max(1, Math.round(wm.height * scale));
				const scaled = scale === 1 ? wm : resizeImage(wm, { width: w, height: h });
				const pos = {
					tl: [margin, margin],
					tc: [Math.round((img.width - w) / 2), margin],
					tr: [img.width - w - margin, margin],
					ml: [margin, Math.round((img.height - h) / 2)],
					center: [Math.round((img.width - w) / 2), Math.round((img.height - h) / 2)],
					mr: [img.width - w - margin, Math.round((img.height - h) / 2)],
					bl: [margin, img.height - h - margin],
					bc: [Math.round((img.width - w) / 2), img.height - h - margin],
					br: [img.width - w - margin, img.height - h - margin],
				}[position] ?? [img.width - w - margin, img.height - h - margin];
				img = compositeOverlay(img, scaled, {
					x: pos[0],
					y: pos[1],
					opacity,
					tile: Boolean(plan.tile),
					gap: Number(plan.gap ?? 8),
				});
				steps.push(`watermark ${wmRel} @${position}`);
			}

			// 6) Output format and quality
			const format = String(o.format ?? cfg.defaultFormat ?? "keep");
			const outFormat = !format || format === "keep" ? (SERVER_ENCODE.has(srcFormat) ? srcFormat : "png") : format;
			const quality = Math.round(Math.min(1, Math.max(0.05, Number(o.quality ?? cfg.quality ?? 0.82))) * 100);
			const written = await writeImage(img, outFormat, quality, rel, o);

			return {
				in: pretty(host.cwd, rel),
				out: written.out,
				srcFormat,
				outFormat: outFormat === "jpeg" ? "jpeg" : outFormat,
				srcBytes: srcBuf.length,
				bytes: written.bytes,
				srcSize: `${src.width}×${src.height}`,
				size: `${img.width}×${img.height}`,
				outRel: written.outRel,
				steps,
			};
		}

		/** Run processOne over a batch: one failure does not blow up the rest (it lands in error). */
		async function processMany(rels, plan, o) {
			const results = [];
			for (const rel of rels) {
				try {
					results.push(await processOne(rel, plan, o));
				} catch (err) {
					results.push({ in: pretty(host.cwd, rel), error: err instanceof Error ? err.message : String(err) });
				}
			}
			return results;
		}

		/** Results → the text summary the model reads. */
		function summarize(results, title) {
			const ok = results.filter((r) => !r.error);
			const bad = results.filter((r) => r.error);
			const lines = [title];
			for (const r of ok) {
				const saved = r.srcBytes && r.bytes ? ` (${fmtBytes(r.srcBytes)} → ${fmtBytes(r.bytes)})` : "";
				const ratio = r.srcBytes && r.bytes ? ` ${Math.round((1 - r.bytes / r.srcBytes) * 100)}%↓` : "";
				lines.push(`✅ ${r.in} → ${r.out}  ${r.srcSize} → ${r.size}  ${r.outFormat}${saved}${ratio}`);
			}
			for (const r of bad) lines.push(`❌ ${r.in}: ${r.error}`);
			return lines.join("\n");
		}

		// ------------------------------------------------------------------
		// AI tool registration (switchable from the settings at runtime)
		// ------------------------------------------------------------------
		const TOOLS = [
			{
				name: "image_info",
				label: "Image info",
				description:
					"Inspect images in the workspace: format, pixel size, aspect ratio, file bytes, alpha, EXIF (camera/exposure/GPS), plus histogram/dominant colors on request. " +
					"Use it before compressing or cropping so you know what you are dealing with. Accepts one path, several paths, or a directory to scan.",
				promptSnippet: "image_info — inspect workspace image metadata (size/format/EXIF), also scans a directory",
				promptGuidelines: [
					"Before compressing or cropping an image, call image_info to learn its real dimensions and format.",
					"image_info accepts a directory to list every image inside (useful for bulk work).",
				],
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Image path relative to the workspace (or absolute inside it)." },
						paths: { type: "array", items: { type: "string" }, description: "Several image paths at once." },
						dir: { type: "string", description: "Directory to scan recursively for images (max depth 3, 200 files)." },
						details: {
							type: "boolean",
							description: "Also compute histogram peaks and dominant colors (slower, decodes pixels).",
						},
					},
				},
				async execute(_id, params) {
					const rels0 = pathList(params);
					const dir = typeof params.dir === "string" ? normalizeRel(params.dir) : "";
					// An explicit dir is always scanned (the empty string = the workspace root)
					if (typeof params.dir === "string") {
						const found = await scanImages(dir, 0, []);
						for (const f of found) if (!rels0.includes(f)) rels0.push(f);
					}
					const rels = rels0;
					if (!rels.length) {
						const entries = await listDir("");
						const imgs = entries.filter((e) => e.isImage).map((e) => e.path);
						return `No path/paths/dir given. Images in the workspace root: ${imgs.length ? imgs.join(", ") : "(none)"}`;
					}
					const rows = [];
					for (const rel of rels) {
						try {
							const buf = await host.fs.read(rel);
							const p = probeImage(buf);
							const row = {
								path: pretty(host.cwd, rel),
								format: p.format,
								size: p.width && p.height ? `${p.width}×${p.height}` : "?",
								megapixels: p.megapixels,
								aspect: p.aspect ? Number(p.aspect.toFixed(4)) : null,
								bytes: buf.length,
								humanBytes: fmtBytes(buf.length),
								alpha: p.hasAlpha,
								animated: p.animated ?? undefined,
								serverEditable: SERVER_DECODE.has(p.format),
								exif: parseExif(buf) ?? undefined,
							};
							if (params.details && SERVER_DECODE.has(p.format)) {
								if (p.format === "jpeg" && !(await ensureJpeg())) {
									row.detailsError = "jpeg-js is required to decode JPEG pixels";
								} else {
									const img = await decodeImage(buf, { maxPixels: MAX_PIXELS });
									const h = histogram(img);
									row.histogramPeak = {
										r: h.r.indexOf(Math.max(...h.r)),
										g: h.g.indexOf(Math.max(...h.g)),
										b: h.b.indexOf(Math.max(...h.b)),
									};
									row.dominantColors = dominantColors(img, 5).map((c) => ({
										hex: `#${c.rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`,
										share: Number(c.share.toFixed(3)),
									}));
								}
							}
							rows.push(row);
						} catch (err) {
							rows.push({ path: pretty(host.cwd, rel), error: err instanceof Error ? err.message : String(err) });
						}
					}
					return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], details: { count: rows.length } };
				},
			},
			{
				name: "image_transform",
				label: "Image geometry/color",
				description:
					"Transform workspace images: resize (width/height/longEdge/percent), crop, rotate 90/arbitrary, flip, and per-pixel adjust (brightness/contrast/saturation/hue/gamma/grayscale/sepia/invert/blur/sharpen/vignette). " +
					"Writes new files (never overwrites unless asked). Supports batch via `paths`. PNG/JPEG/BMP only — WebP/GIF/AVIF belong in the 🖼 view.",
				promptSnippet:
					"image_transform — resize / crop / rotate / flip / adjust workspace images (PNG/JPEG/BMP, batch ok)",
				promptGuidelines: [
					"image_transform never overwrites the source unless overwrite=true; by default it writes <name><suffix>.<ext> next to the original (or into outDir).",
					"Crop coordinates from image_info are 1:1 pixels of the *current* file; if you also rotate, crop applies after rotation.",
					"For 'make the long edge 1600px' use resize.longEdge=1600 (noUpscale defaults to true).",
					"Passing both resize.width and resize.height means exact dimensions — that overrides the no-upscale default.",
				],
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Image path (relative to workspace)." },
						paths: {
							type: "array",
							items: { type: "string" },
							description: "Batch: several images with the same plan.",
						},
						resize: {
							type: "object",
							description: "Resize. Give one of: width/height (px), longEdge (px, the longer side), percent (%).",
							properties: {
								width: { type: "number" },
								height: { type: "number" },
								longEdge: { type: "number" },
								percent: { type: "number" },
								noUpscale: {
									type: "boolean",
									description:
										"Default true: never enlarge beyond the source. Ignored when both width and height are given.",
								},
							},
						},
						crop: {
							type: "object",
							description: "Crop rectangle in pixels of the rotated image (top-left origin).",
							properties: {
								x: { type: "number" },
								y: { type: "number" },
								width: { type: "number" },
								height: { type: "number" },
							},
						},
						rotate: { type: "number", description: "90/180/270 (clockwise degrees)." },
						flip: { type: "string", enum: ["h", "v"], description: "Horizontal or vertical mirror." },
						angle: {
							type: "number",
							description: "Arbitrary rotation in degrees (canvas expands, background param fills).",
						},
						background: {
							type: "string",
							description: "Fill for arbitrary rotation, e.g. #ffffff or #ffffff00 (default transparent).",
						},
						adjust: {
							type: "object",
							description: "Per-pixel adjustments. Percentages default to 100 (=unchanged), strength fields 0..100.",
							properties: {
								brightness: { type: "number" },
								contrast: { type: "number" },
								saturation: { type: "number" },
								hue: { type: "number", description: "Degrees, -180..180" },
								gamma: { type: "number" },
								grayscale: { type: "number" },
								sepia: { type: "number" },
								invert: { type: "number" },
								blur: { type: "number", description: "0..50 px radius" },
								sharpen: { type: "number" },
								vignette: { type: "number" },
							},
						},
						format: {
							type: "string",
							enum: ["png", "jpeg", "bmp", "keep"],
							description: "Output format (default: plugin setting / keep).",
						},
						quality: { type: "number", description: "JPEG quality 0.1..1 (ignored by PNG/BMP)." },
						out: { type: "string", description: "Explicit output path (single file only)." },
						outDir: { type: "string", description: "Directory for outputs (created if missing)." },
						suffix: {
							type: "string",
							description: "Filename suffix (default -min; changeable in the 🖼 view ⚙ settings).",
						},
						overwrite: { type: "boolean", description: "Allow replacing an existing file." },
					},
				},
				async execute(_id, params) {
					const rels = pathList(params);
					if (!rels.length) throw new Error("Missing path (or paths)");
					if (rels.length > 1 && params.out) throw new Error("out cannot be used for a batch (use outDir + suffix)");
					const results = await processMany(rels, params, params);
					return {
						content: [{ type: "text", text: summarize(results, `Processed ${results.length} file(s):`) }],
						details: { results },
					};
				},
			},
			{
				name: "image_compress",
				label: "Compress images",
				description:
					"Compress workspace images: convert format (png/jpeg/bmp) and/or hit a target file size with a quality binary search (plus downscaling when quality alone is not enough). " +
					"Use `targetKB` for 'under 300 KB' requests and `quality` for a fixed quality. Batch via `paths`.",
				promptSnippet: "image_compress — shrink workspace images to a quality or a target file size (batch ok)",
				promptGuidelines: [
					"To hit a size budget, pass targetKB — do not guess quality by hand, the tool binary-searches it.",
					"Compressing a PNG meaningfully usually means converting to jpeg or webp; jpeg is what the server can write (webp only in the 🖼 view).",
				],
				parameters: {
					type: "object",
					properties: {
						path: { type: "string" },
						paths: { type: "array", items: { type: "string" } },
						quality: {
							type: "number",
							description: "JPEG quality 0.1..1 (default 0.82; changeable in the 🖼 view ⚙ settings).",
						},
						targetKB: { type: "number", description: "Desired maximum file size in KB. Overrides quality." },
						format: {
							type: "string",
							enum: ["jpeg", "png", "bmp", "keep"],
							description: "Output format (default jpeg when compressing).",
						},
						maxLongEdge: {
							type: "number",
							description: "Optional cap on the longer side in px (applied before encoding).",
						},
						outDir: { type: "string" },
						suffix: { type: "string" },
						overwrite: { type: "boolean" },
					},
				},
				async execute(_id, params) {
					const rels = pathList(params);
					if (!rels.length) throw new Error("Missing path (or paths)");
					const o = { ...params, format: params.format ?? "jpeg" };
					const targetBytes = params.targetKB ? Number(params.targetKB) * 1024 : 0;
					const results = [];
					for (const rel of rels) {
						try {
							const { buf, format: srcFormat, img: src } = await loadImage(rel);
							let img = src;
							if (params.maxLongEdge) {
								const le = Number(params.maxLongEdge);
								const w = img.width >= img.height ? le : Math.round((img.width * le) / img.height);
								const h = img.width >= img.height ? Math.round((img.height * le) / img.width) : le;
								if (w < img.width || h < img.height) img = resizeImage(img, { width: w, height: h });
							}
							const outFormat =
								String(o.format) === "keep" ? (SERVER_ENCODE.has(srcFormat) ? srcFormat : "jpeg") : String(o.format);
							if (!SERVER_ENCODE.has(outFormat)) throw new Error(`The server cannot write ${outFormat}`);
							if (outFormat === "jpeg" && !(await ensureJpeg()))
								throw new Error(
									"jpeg-js is required (allow it in the ⚙ settings at the top right of the 🖼 view and retry)",
								);
							if (!SERVER_ENCODE.has(srcFormat) && srcFormat === "jpeg") await ensureJpeg();

							let quality = Math.round(Math.min(1, Math.max(0.1, Number(params.quality ?? cfg.quality ?? 0.82))) * 100);
							let encoded = await encodeImage(img, outFormat, { quality });
							let usedQuality = quality;
							if (targetBytes > 0 && outFormat === "jpeg") {
								// Binary search: converge below the target within 7 encodes (quality floor 10)
								let lo = 10;
								let hi = 100;
								let best = null;
								for (let i = 0; i < 7; i++) {
									const mid = Math.round((lo + hi) / 2);
									const candidate = await encodeImage(img, outFormat, { quality: mid });
									if (candidate.length <= targetBytes) {
										best = { buf: candidate, q: mid };
										lo = mid + 1;
									} else {
										hi = mid - 1;
									}
									if (lo > hi) break;
								}
								// Still too big at the lowest quality → downscale by area ratio and encode once more
								if (!best) {
									const shrink = Math.sqrt(targetBytes / encoded.length);
									const w = Math.max(1, Math.round(img.width * shrink * 0.98));
									const h = Math.max(1, Math.round(img.height * shrink * 0.98));
									img = resizeImage(img, { width: w, height: h });
									encoded = await encodeImage(img, outFormat, { quality: 60 });
									best = { buf: encoded, q: 60 };
								}
								encoded = best.buf;
								usedQuality = best.q;
							}
							const relOut = await resolveOutPath(rel, EXT_OF[outFormat] ?? outFormat, params);
							await host.fs.write(relOut, encoded);
							results.push({
								in: pretty(host.cwd, rel),
								out: pretty(host.cwd, relOut),
								outRel: relOut,
								srcFormat,
								outFormat,
								srcSize: `${src.width}×${src.height}`,
								size: `${img.width}×${img.height}`,
								srcBytes: buf.length,
								bytes: encoded.length,
								quality: usedQuality,
							});
						} catch (err) {
							results.push({ in: pretty(host.cwd, rel), error: err instanceof Error ? err.message : String(err) });
						}
					}
					return {
						content: [{ type: "text", text: summarize(results, `Compressed ${results.length} file(s):`) }],
						details: { results },
					};
				},
			},
			{
				name: "image_watermark",
				label: "Image watermark",
				description:
					"Stamp an image (logo/PNG with alpha) onto workspace images: 9-grid position, opacity, scale, margin, or full tiling. " +
					"Text watermarks with real fonts are browser-side only (🖼 view).",
				promptSnippet: "image_watermark — overlay a logo image onto workspace images (position/opacity/tile)",
				promptGuidelines: [
					"image_watermark takes an image overlay, not text — for text watermarks tell the user to use the 🖼 view (real fonts are browser-side).",
					'A watermarked output defaults to <name>-wm.<ext> next to the source if you pass suffix="-wm".',
				],
				parameters: {
					type: "object",
					properties: {
						path: { type: "string" },
						paths: { type: "array", items: { type: "string" } },
						watermarkPath: { type: "string", description: "Overlay image path (PNG with alpha works best)." },
						position: {
							type: "string",
							enum: ["tl", "tc", "tr", "ml", "center", "mr", "bl", "bc", "br"],
							description: "Default br.",
						},
						opacity: { type: "number", description: "0..1, default 0.8" },
						scale: { type: "number", description: "Overlay scale factor, default 1." },
						margin: { type: "number", description: "Margin in px from the edges (ignored when tiling)." },
						tile: { type: "boolean", description: "Tile the overlay across the whole image." },
						gap: { type: "number", description: "Tile spacing in px, default 8." },
						suffix: { type: "string", description: "Default -wm." },
						outDir: { type: "string" },
						overwrite: { type: "boolean" },
					},
					required: ["watermarkPath"],
				},
				async execute(_id, params) {
					const rels = pathList(params);
					if (!rels.length) throw new Error("Missing path (or paths)");
					if (!params.watermarkPath) throw new Error("Missing watermarkPath (the overlay image path)");
					const o = { ...params, suffix: params.suffix ?? "-wm" };
					const results = await processMany(rels, { watermarkPath: params.watermarkPath, ...params }, o);
					return {
						content: [{ type: "text", text: summarize(results, `Watermarked ${results.length} file(s):`) }],
						details: { results },
					};
				},
			},
		];

		/** Register/unregister the AI tools according to the settings (idempotent). */
		function syncTools() {
			const want = cfg.aiTools !== false;
			if (want === toolsOn) return;
			if (want) {
				offTools = TOOLS.map((t) => host.registerAgentTool(t));
				toolsOn = true;
				host.log(`AI tools registered: ${TOOLS.map((t) => t.name).join(", ")}`);
			} else {
				for (const off of offTools) {
					try {
						off();
					} catch {
						/* Ignore unregister failures */
					}
				}
				offTools = [];
				toolsOn = false;
				host.log("AI tools unregistered (switched off in the settings)");
			}
		}
		syncTools();
		// Config changes come in through POST /ws/settings (the view's ⚙), see the routes below;
		// the manifest no longer declares settings, so onSettingsChanged never fires.

		// ------------------------------------------------------------------
		// HTTP routes (used by the view)
		// ------------------------------------------------------------------

		/** Read the request body: JSON base64 (small images) or raw binary (large ones, no 10mb JSON cap). */
		async function readBody(req) {
			const b = req.body;
			if (b && typeof b === "object" && typeof b.dataBase64 === "string") {
				return Buffer.from(b.dataBase64, "base64");
			}
			const chunks = [];
			for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
			return Buffer.concat(chunks);
		}

		/**
		 * Route wrapper: anything the handler throws (read failure, escape attempt, encode failure…)
		 * becomes an HTTP 4xx/5xx and never escapes as a rejected promise — the host's handleHttp only
		 * try/catches synchronous throws, and an async handler's rejection turns into an
		 * unhandledRejection that takes the whole service down (observed in practice).
		 */
		function safeRoute(method, path, handler) {
			return host.route(method, path, async (req, res) => {
				try {
					await handler(req, res);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					host.log("error", `http ${method} ${path} failed:`, msg);
					if (!res.headersSent) res.status(400).json({ error: msg });
					else res.end();
				}
			});
		}

		const offList = safeRoute("GET", "/ws/list", async (req, res) => {
			const dir = normalizeRel(req.query?.dir);
			res.json({ cwd: host.cwd, dir, entries: await listDir(dir) });
		});

		const offImage = safeRoute("GET", "/ws/image", async (req, res) => {
			const rel = normalizeRel(req.query?.path);
			if (!rel) {
				res.status(400).json({ error: "Missing path" });
				return;
			}
			const buf = await host.fs.read(rel);
			res.setHeader("Cache-Control", "no-store");
			res.type(mimeForFormat(sniffFormat(buf))).send(buf);
		});

		const offProbe = safeRoute("GET", "/ws/probe", async (req, res) => {
			const rel = normalizeRel(req.query?.path);
			if (!rel) {
				res.status(400).json({ error: "Missing path" });
				return;
			}
			const buf = await host.fs.read(rel);
			const p = probeImage(buf);
			res.json({
				path: rel,
				name: basename(rel),
				bytes: buf.length,
				...p,
				exif: parseExif(buf),
				serverEditable: SERVER_DECODE.has(p.format),
			});
		});

		const offSave = safeRoute("POST", "/ws/save", async (req, res) => {
			const rel = normalizeRel(req.query?.path);
			if (!rel) {
				res.status(400).json({ error: "Missing path" });
				return;
			}
			const data = await readBody(req);
			if (!data.length) {
				res.status(400).json({ error: "The request body is empty" });
				return;
			}
			const overwrite = String(req.query?.overwrite ?? "") === "1";
			// Without overwrite keep the original stem and let resolveOutPath rename it (a.png → a-1.png)
			const relOut = overwrite
				? rel
				: await resolveOutPath(rel, extname(rel).replace(/^\./, "") || "bin", {
						outDir: normalizeRel(dirname(rel)),
						suffix: "",
					});
			await host.fs.write(relOut, data);
			host.log(`Saved ${pretty(host.cwd, relOut)} (${fmtBytes(data.length)})`);
			res.json({
				ok: true,
				path: relOut,
				pretty: pretty(host.cwd, relOut),
				bytes: data.length,
				renamed: relOut !== rel,
			});
		});

		const offSettingsRoute = safeRoute("GET", "/ws/settings", async (_req, res) => {
			res.json({ cwd: host.cwd, settings: cfg, serverFormats: [...SERVER_ENCODE] });
		});

		const offSaveSettings = safeRoute("POST", "/ws/settings", async (req, res) => {
			const body = req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : {};
			const patch = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : body;
			res.json({ ok: true, cwd: host.cwd, settings: saveConfig(patch) });
		});

		host.log(`Activated; workspace ${host.cwd}; AI tools ${cfg.aiTools === false ? "off" : "on"}`);

		// Deactivation: drop every route and tool registration (plugin removed / service stopped)
		return () => {
			for (const off of [offList, offImage, offProbe, offSave, offSettingsRoute, offSaveSettings]) {
				try {
					off?.();
				} catch {
					/* Ignore */
				}
			}
			for (const off of offTools) {
				try {
					off();
				} catch {
					/* Ignore */
				}
			}
			offTools = [];
			host.log("Deactivated");
		};
	},
};
