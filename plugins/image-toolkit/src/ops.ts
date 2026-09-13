// @ts-nocheck
/**
 * image-toolkit  JS RgbaImage
 *
 *
 *   -  Uint8Array/Uint8ClampedArray
 *   - /gamma 256  LUT
 *   -  = box
 *      =  2
 */

// ---------------------------------------------------------------------------
//
// ---------------------------------------------------------------------------

/**  RgbaImage  */
function assertImage(img, who = "") {
	if (!img || typeof img !== "object") throw new Error(`${who}`);
	const { width, height, data } = img;
	if (!Number.isInteger(width) || width <= 0) throw new Error("");
	if (!Number.isInteger(height) || height <= 0) throw new Error("");
	if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) {
		throw new Error(`${who} Uint8ArrayRGBA8`);
	}
	if (data.length !== width * height * 4) {
		throw new Error(`${who} ${data.length}  ${width}×${height} `);
	}
	return img;
}

/**  RGBA format  "rgba"  */
function newImage(width, height, hasAlpha = true) {
	return { width, height, data: new Uint8Array(width * height * 4), hasAlpha, format: "rgba" };
}

function copyImage(img) {
	return {
		width: img.width,
		height: img.height,
		data: new Uint8Array(img.data),
		hasAlpha: img.hasAlpha,
		format: img.format,
	};
}

/**
 *  +  Uint8ClampedArray
 *  Uint8Array  Uint8Array
 */
function clampView(arr) {
	return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function clampInt(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
//
// ---------------------------------------------------------------------------

/**
 *
 * scale >= 1/ =
 * scale < 1
 */
function axisWeights(srcSize, dstSize) {
	const scale = srcSize / dstSize;
	const out = new Array(dstSize);
	for (let d = 0; d < dstSize; d++) {
		const s0 = d * scale;
		const s1 = s0 + scale;
		const idx = [];
		const wts = [];
		if (scale >= 1) {
			const i0 = Math.floor(s0);
			const i1 = Math.min(srcSize - 1, Math.ceil(s1) - 1);
			for (let i = i0; i <= i1; i++) {
				const overlap = Math.min(i + 1, s1) - Math.max(i, s0);
				if (overlap > 0) {
					idx.push(i);
					wts.push(overlap);
				}
			}
		} else {
			const center = (s0 + s1) / 2 - 0.5;
			const f = Math.floor(center);
			const frac = center - f;
			const a = clampInt(f, 0, srcSize - 1);
			const b = clampInt(f + 1, 0, srcSize - 1);
			if (a === b) {
				idx.push(a);
				wts.push(1);
			} else {
				idx.push(a);
				wts.push(1 - frac);
				idx.push(b);
				wts.push(frac);
			}
		}
		const sum = wts.reduce((x, y) => x + y, 0) || 1;
		out[d] = { idx: Int32Array.from(idx), wts: Float64Array.from(wts, (v) => v / sum) };
	}
	return out;
}

/**
 *  width/height
 *  Float32
 * quality
 */
export function resizeImage(img, { width, height, quality } = {}) {
	void quality;
	assertImage(img);
	let w = width == null ? null : Math.round(width);
	let h = height == null ? null : Math.round(height);
	if (w == null && h == null) throw new Error(" width  height");
	if (w != null && (!Number.isFinite(w) || w <= 0)) throw new Error("");
	if (h != null && (!Number.isFinite(h) || h <= 0)) throw new Error("");
	if (w == null) w = Math.max(1, Math.round((h * img.width) / img.height));
	if (h == null) h = Math.max(1, Math.round((w * img.height) / img.width));
	if (w === img.width && h === img.height) return copyImage(img);

	const { width: sw, height: sh, data } = img;
	const xw = axisWeights(sw, w);
	const yw = axisWeights(sh, h);

	//  → Float32
	const mid = new Float32Array(w * sh * 4);
	for (let y = 0; y < sh; y++) {
		const srcRow = y * sw * 4;
		const dstRow = y * w * 4;
		for (let x = 0; x < w; x++) {
			const { idx, wts } = xw[x];
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let k = 0; k < idx.length; k++) {
				const s = srcRow + idx[k] * 4;
				const wk = wts[k];
				r += data[s] * wk;
				g += data[s + 1] * wk;
				b += data[s + 2] * wk;
				a += data[s + 3] * wk;
			}
			const o = dstRow + x * 4;
			mid[o] = r;
			mid[o + 1] = g;
			mid[o + 2] = b;
			mid[o + 3] = a;
		}
	}

	//  →
	const out = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) {
		const { idx, wts } = yw[y];
		const dstRow = y * w * 4;
		for (let x = 0; x < w; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let k = 0; k < idx.length; k++) {
				const s = idx[k] * w * 4 + x * 4;
				const wk = wts[k];
				r += mid[s] * wk;
				g += mid[s + 1] * wk;
				b += mid[s + 2] * wk;
				a += mid[s + 3] * wk;
			}
			const o = dstRow + x * 4;
			out[o] = r;
			out[o + 1] = g;
			out[o + 2] = b;
			out[o + 3] = a;
		}
	}
	return { width: w, height: h, data: clampView(out), hasAlpha: img.hasAlpha, format: "rgba" };
}

// ---------------------------------------------------------------------------
//  /  /
// ---------------------------------------------------------------------------

/** x/y  (0,0,0,0)width/height  1 */
export function cropImage(img, { x = 0, y = 0, width, height } = {}) {
	assertImage(img);
	const cx = Math.trunc(x) || 0;
	const cy = Math.trunc(y) || 0;
	const w = Math.max(1, Math.trunc(width ?? img.width));
	const h = Math.max(1, Math.trunc(height ?? img.height));
	const out = newImage(w, h, img.hasAlpha);
	const { width: sw, height: sh, data } = img;
	for (let yy = 0; yy < h; yy++) {
		const sy = cy + yy;
		if (sy < 0 || sy >= sh) continue;
		for (let xx = 0; xx < w; xx++) {
			const sx = cx + xx;
			if (sx < 0 || sx >= sw) continue;
			const s = (sy * sw + sx) * 4;
			const o = (yy * w + xx) * 4;
			out.data[o] = data[s];
			out.data[o + 1] = data[s + 1];
			out.data[o + 2] = data[s + 2];
			out.data[o + 3] = data[s + 3];
		}
	}
	return out;
}

/** 90  90° =  */
export function rotateImage(img, degrees) {
	assertImage(img);
	if (!Number.isFinite(degrees)) throw new Error("");
	const k = ((Math.round(degrees / 90) % 4) + 4) % 4;
	const { width: w, height: h, data } = img;
	if (k === 0) return copyImage(img);
	const out = newImage(k === 2 ? w : h, k === 2 ? h : w, img.hasAlpha);
	const ow = out.width;
	const oh = out.height;
	for (let y = 0; y < oh; y++) {
		for (let x = 0; x < ow; x++) {
			let sx;
			let sy;
			if (k === 1) {
				sx = y;
				sy = h - 1 - x;
			} else if (k === 2) {
				sx = w - 1 - x;
				sy = h - 1 - y;
			} else {
				sx = w - 1 - y;
				sy = x;
			}
			const s = (sy * w + sx) * 4;
			const o = (y * ow + x) * 4;
			out.data[o] = data[s];
			out.data[o + 1] = data[s + 1];
			out.data[o + 2] = data[s + 2];
			out.data[o + 3] = data[s + 3];
		}
	}
	return out;
}

/** axis="h" axis="v"  */
export function flipImage(img, axis) {
	assertImage(img);
	if (axis !== "h" && axis !== "v") throw new Error(' "h" "v"');
	const { width: w, height: h, data } = img;
	const out = newImage(w, h, img.hasAlpha);
	for (let y = 0; y < h; y++) {
		const sy = axis === "v" ? h - 1 - y : y;
		for (let x = 0; x < w; x++) {
			const sx = axis === "h" ? w - 1 - x : x;
			const s = (sy * w + sx) * 4;
			const o = (y * w + x) * 4;
			out.data[o] = data[s];
			out.data[o + 1] = data[s + 1];
			out.data[o + 2] = data[s + 2];
			out.data[o + 3] = data[s + 3];
		}
	}
	return out;
}

/**  background */
function sampleBilinear(img, sx, sy, background) {
	const { width: w, height: h, data } = img;
	if (sx < -1 || sy < -1 || sx > w || sy > h) return background;
	const x0 = Math.floor(sx);
	const y0 = Math.floor(sy);
	const fx = sx - x0;
	const fy = sy - y0;
	let r = 0;
	let g = 0;
	let b = 0;
	let a = 0;
	for (let j = 0; j < 2; j++) {
		const yy = y0 + j;
		if (yy < 0 || yy >= h) continue;
		const wy = j === 0 ? 1 - fy : fy;
		if (wy === 0) continue;
		for (let i = 0; i < 2; i++) {
			const xx = x0 + i;
			if (xx < 0 || xx >= w) continue;
			const wx = i === 0 ? 1 - fx : fx;
			if (wx === 0) continue;
			const s = (yy * w + xx) * 4;
			const wxy = wx * wy;
			r += data[s] * wxy;
			g += data[s + 1] * wxy;
			b += data[s + 2] * wxy;
			a += data[s + 3] * wxy;
		}
	}
	//  background
	if (x0 < 0 || x0 + 1 >= w || y0 < 0 || y0 + 1 >= h) {
		let covered = 0;
		for (let j = 0; j < 2; j++) {
			const yy = y0 + j;
			if (yy < 0 || yy >= h) continue;
			const wy = j === 0 ? 1 - fy : fy;
			for (let i = 0; i < 2; i++) {
				const xx = x0 + i;
				if (xx < 0 || xx >= w) continue;
				covered += (i === 0 ? 1 - fx : fx) * wy;
			}
		}
		if (covered < 1) {
			const rest = 1 - covered;
			r += background[0] * rest;
			g += background[1] * rest;
			b += background[2] * rest;
			a += background[3] * rest;
		}
	}
	return [r, g, b, a];
}

/**
 *  +
 * expand=true  background
 *  =
 */
export function rotateArbitrary(img, degrees, { background = [0, 0, 0, 0], expand = true } = {}) {
	assertImage(img);
	if (!Number.isFinite(degrees)) throw new Error("");
	if (!Array.isArray(background) || background.length !== 4) throw new Error(" [r,g,b,a] ");
	const { width: w, height: h } = img;
	const rad = (degrees * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const outW = expand ? Math.max(1, Math.ceil(Math.abs(w * cos) + Math.abs(h * sin))) : w;
	const outH = expand ? Math.max(1, Math.ceil(Math.abs(w * sin) + Math.abs(h * cos))) : h;
	const out = new Uint8ClampedArray(outW * outH * 4);
	const cx = outW / 2;
	const cy = outH / 2;
	const bg = [background[0], background[1], background[2], background[3]];
	for (let y = 0; y < outH; y++) {
		const dy = y + 0.5 - cy;
		for (let x = 0; x < outW; x++) {
			const dx = x + 0.5 - cx;
			//  →
			const sx = dx * cos + dy * sin + w / 2 - 0.5;
			const sy = -dx * sin + dy * cos + h / 2 - 0.5;
			const [r, g, b, a] = sampleBilinear(img, sx, sy, bg);
			const o = (y * outW + x) * 4;
			out[o] = r;
			out[o + 1] = g;
			out[o + 2] = b;
			out[o + 3] = a;
		}
	}
	return { width: outW, height: outH, data: clampView(out), hasAlpha: true, format: "rgba" };
}

// ---------------------------------------------------------------------------
//  /
// ---------------------------------------------------------------------------

/**  box blur + RGB alpha  */
function boxBlurOnce(src, w, h, radius) {
	const len = w * h * 4;
	const tmp = new Uint8ClampedArray(len);
	const out = new Uint8ClampedArray(len);
	const win = radius * 2 + 1;
	const maxX = w - 1;
	const maxY = h - 1;
	for (let y = 0; y < h; y++) {
		const base = y * w * 4;
		for (let c = 0; c < 3; c++) {
			let sum = 0;
			for (let k = -radius; k <= radius; k++) sum += src[base + clampInt(k, 0, maxX) * 4 + c];
			for (let x = 0; x < w; x++) {
				tmp[base + x * 4 + c] = sum / win;
				sum +=
					src[base + clampInt(x + radius + 1, 0, maxX) * 4 + c] - src[base + clampInt(x - radius, 0, maxX) * 4 + c];
			}
		}
		for (let x = 0; x < w; x++) tmp[base + x * 4 + 3] = src[base + x * 4 + 3];
	}
	for (let x = 0; x < w; x++) {
		for (let c = 0; c < 3; c++) {
			let sum = 0;
			for (let k = -radius; k <= radius; k++) sum += tmp[clampInt(k, 0, maxY) * w * 4 + x * 4 + c];
			for (let y = 0; y < h; y++) {
				out[y * w * 4 + x * 4 + c] = sum / win;
				sum +=
					tmp[clampInt(y + radius + 1, 0, maxY) * w * 4 + x * 4 + c] -
					tmp[clampInt(y - radius, 0, maxY) * w * 4 + x * 4 + c];
			}
		}
		for (let y = 0; y < h; y++) out[y * w * 4 + x * 4 + 3] = tmp[y * w * 4 + x * 4 + 3];
	}
	return out;
}

/**  passes  box blur3  */
function boxBlur(src, w, h, radius, passes) {
	let cur = src;
	for (let i = 0; i < passes; i++) cur = boxBlurOnce(cur, w, h, radius);
	return cur;
}

// ---------------------------------------------------------------------------
//  /
// ---------------------------------------------------------------------------

const LUMA = [0.2126, 0.7152, 0.0722];
const SEPIA = [
	[0.393, 0.769, 0.189],
	[0.349, 0.686, 0.168],
	[0.272, 0.534, 0.131],
];

function mul3(a, b) {
	const out = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	];
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
	}
	return out;
}

/**  3×3 */
function hueMatrix(deg) {
	const rad = (deg * Math.PI) / 180;
	const c = Math.cos(rad);
	const s = Math.sin(rad);
	return [
		[0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
		[0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283],
		[0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
	];
}

/** 100 = 0 = >100  */
function satMatrix(percent) {
	const s = percent / 100;
	const k = 1 - s;
	const [wr, wg, wb] = LUMA;
	return [
		[s + k * wr, k * wg, k * wb],
		[k * wr, s + k * wg, k * wb],
		[k * wr, k * wg, s + k * wb],
	];
}

function grayMatrix(percent) {
	const g = percent / 100;
	const [wr, wg, wb] = LUMA;
	return [
		[1 - g + g * wr, g * wg, g * wb],
		[g * wr, 1 - g + g * wg, g * wb],
		[g * wr, g * wg, 1 - g + g * wb],
	];
}

function sepiaMatrix(percent) {
	const p = percent / 100;
	return SEPIA.map((row, i) => row.map((v, j) => (i === j ? 1 - p : 0) + v * p));
}

/**
 * /“”
 * / LUT → × → //→ gamma LUT →  →  →
 * brightness/contrast/saturation/gamma 100 = hue
 * grayscale/sepia/invert/vignette  0..100 blur  0..50 3  box blur
 * sharpen  0..100unsharp mask
 */
export function adjustImage(img, opts = {}) {
	assertImage(img);
	const brightness = opts.brightness ?? 100;
	const contrast = opts.contrast ?? 100;
	const saturation = opts.saturation ?? 100;
	const hue = opts.hue ?? 0;
	const gamma = opts.gamma ?? 100;
	const grayscale = opts.grayscale ?? 0;
	const sepia = opts.sepia ?? 0;
	const invert = opts.invert ?? 0;
	const blur = opts.blur ?? 0;
	const sharpen = opts.sharpen ?? 0;
	const vignette = opts.vignette ?? 0;
	for (const [name, v, lo, hi] of [
		["", brightness, 0, 1000],
		["", contrast, 0, 1000],
		["", saturation, 0, 1000],
		["gamma", gamma, 1, 1000],
		["", grayscale, 0, 100],
		["", sepia, 0, 100],
		["", invert, 0, 100],
		["", blur, 0, 50],
		["", sharpen, 0, 100],
		["", vignette, 0, 100],
	]) {
		if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name} ${lo}..${hi} `);
	}
	if (!Number.isFinite(hue)) throw new Error("");

	const { width: w, height: h, data } = img;

	// 1)  +  256  LUT
	const toneLut = new Uint8ClampedArray(256);
	const bf = brightness / 100;
	const cf = contrast / 100;
	for (let v = 0; v < 256; v++) toneLut[v] = (v * bf - 128) * cf + 128;

	// 2)  ×  3×3
	const m1 = mul3(hueMatrix(hue), satMatrix(saturation));

	// 3)  →  →  +
	let m2 = grayMatrix(grayscale);
	m2 = mul3(sepiaMatrix(sepia), m2);
	const invScale = 1 - (2 * invert) / 100;
	const invOffset = (255 * invert) / 100;
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m2[i][j] *= invScale;

	// 4) gamma
	const gammaLut = new Uint8ClampedArray(256);
	const exp = 100 / gamma;
	for (let v = 0; v < 256; v++) gammaLut[v] = 255 * Math.pow(v / 255, exp);

	// 5)
	let vig = null;
	if (vignette > 0) {
		vig = new Float32Array(w * h);
		const cx = (w - 1) / 2;
		const cy = (h - 1) / 2;
		const maxD = Math.hypot(cx, cy) || 1;
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const d = Math.hypot(x - cx, y - cy) / maxD;
				vig[y * w + x] = 1 - (vignette / 100) * d * d;
			}
		}
	}

	const out = new Uint8ClampedArray(data.length);
	const rowM = [m1[0][0], m1[0][1], m1[0][2], m1[1][0], m1[1][1], m1[1][2], m1[2][0], m1[2][1], m1[2][2]];
	const rowS = [m2[0][0], m2[0][1], m2[0][2], m2[1][0], m2[1][1], m2[1][2], m2[2][0], m2[2][1], m2[2][2]];
	for (let i = 0, p = 0; i < data.length; i += 4, p++) {
		const r0 = toneLut[data[i]];
		const g0 = toneLut[data[i + 1]];
		const b0 = toneLut[data[i + 2]];
		const r1 = rowM[0] * r0 + rowM[1] * g0 + rowM[2] * b0;
		const g1 = rowM[3] * r0 + rowM[4] * g0 + rowM[5] * b0;
		const b1 = rowM[6] * r0 + rowM[7] * g0 + rowM[8] * b0;
		const r2 = rowS[0] * r1 + rowS[1] * g1 + rowS[2] * b1 + invOffset;
		const g2 = rowS[3] * r1 + rowS[4] * g1 + rowS[5] * b1 + invOffset;
		const b2 = rowS[6] * r1 + rowS[7] * g1 + rowS[8] * b1 + invOffset;
		const rf = r2 < 0 ? 0 : r2 > 255 ? 255 : r2;
		const gf = g2 < 0 ? 0 : g2 > 255 ? 255 : g2;
		const bf2 = b2 < 0 ? 0 : b2 > 255 ? 255 : b2;
		let vr = gammaLut[(rf + 0.5) | 0];
		let vg = gammaLut[(gf + 0.5) | 0];
		let vb = gammaLut[(bf2 + 0.5) | 0];
		if (vig) {
			const f = vig[p];
			vr *= f;
			vg *= f;
			vb *= f;
		}
		out[i] = vr;
		out[i + 1] = vg;
		out[i + 2] = vb;
		out[i + 3] = data[i + 3];
	}

	let result = out;
	if (blur > 0) result = boxBlur(result, w, h, Math.max(1, Math.round(blur)), 3);
	if (sharpen > 0) {
		const amount = sharpen / 100;
		const blurred = boxBlur(result, w, h, 1, 1);
		const sharp = new Uint8ClampedArray(result.length);
		for (let i = 0; i < result.length; i += 4) {
			for (let c = 0; c < 3; c++) {
				const o = result[i + c];
				sharp[i + c] = o + amount * (o - blurred[i + c]);
			}
			sharp[i + 3] = result[i + 3];
		}
		result = sharp;
	}
	return { width: w, height: h, data: clampView(result), hasAlpha: img.hasAlpha, format: "rgba" };
}

// ---------------------------------------------------------------------------
//  /  /
// ---------------------------------------------------------------------------

/**
 *  overlay source-overalpha  base  base
 * x/y  overlay opacity 0..1scale  overlay
 * tile=true  gap  base x/y
 */
export function compositeOverlay(base, overlay, { x = 0, y = 0, opacity = 1, scale = 1, tile = false, gap = 8 } = {}) {
	assertImage(base, "");
	assertImage(overlay, "");
	if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error(" 0..1 ");
	if (!Number.isFinite(scale) || scale <= 0) throw new Error("");
	if (!Number.isFinite(gap) || gap < 0) throw new Error("");
	const ov = scale === 1 ? overlay : resizeImage(overlay, { width: Math.max(1, Math.round(overlay.width * scale)) });
	const { width: bw, height: bh, data } = base;
	const out = new Uint8ClampedArray(data);
	const ow = ov.width;
	const oh = ov.height;
	const ox = Math.trunc(x) || 0;
	const oy = Math.trunc(y) || 0;

	const blendOne = (px, py) => {
		for (let sy = 0; sy < oh; sy++) {
			const ty = py + sy;
			if (ty < 0 || ty >= bh) continue;
			for (let sx = 0; sx < ow; sx++) {
				const tx = px + sx;
				if (tx < 0 || tx >= bw) continue;
				const s = (sy * ow + sx) * 4;
				const o = (ty * bw + tx) * 4;
				const sa = (ov.data[s + 3] / 255) * opacity;
				if (sa <= 0) continue;
				const ia = 1 - sa;
				out[o] = ov.data[s] * sa + out[o] * ia;
				out[o + 1] = ov.data[s + 1] * sa + out[o + 1] * ia;
				out[o + 2] = ov.data[s + 2] * sa + out[o + 2] * ia;
				out[o + 3] = (sa + (out[o + 3] / 255) * ia) * 255;
			}
		}
	};

	if (tile) {
		const stepX = ow + Math.round(gap);
		const stepY = oh + Math.round(gap);
		for (let py = 0; py < bh; py += stepY) {
			for (let px = 0; px < bw; px += stepX) blendOne(px, py);
		}
	} else {
		blendOne(ox, oy);
	}
	return { width: bw, height: bh, data: clampView(out), hasAlpha: true, format: "rgba" };
}

/**  1px  min(w,h)/2 */
export function roundCorners(img, radius) {
	assertImage(img);
	const r0 = Math.round(radius);
	if (!Number.isFinite(r0) || r0 < 0) throw new Error("");
	const r = Math.min(r0, Math.floor(Math.min(img.width, img.height) / 2));
	if (r <= 0) return copyImage(img);
	const { width: w, height: h } = img;
	const out = new Uint8Array(img.data);
	for (let y = 0; y < h; y++) {
		let cy = null;
		if (y < r) cy = r;
		else if (y >= h - r) cy = h - r;
		if (cy == null) continue;
		for (let x = 0; x < w; x++) {
			let cx = null;
			if (x < r) cx = r;
			else if (x >= w - r) cx = w - r;
			if (cx == null) continue;
			const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
			const cov = r + 0.5 - d;
			if (cov >= 1) continue;
			const i = (y * w + x) * 4 + 3;
			out[i] = Math.round(out[i] * (cov <= 0 ? 0 : cov));
		}
	}
	return { width: w, height: h, data: out, hasAlpha: true, format: "rgba" };
}

/** [r,g,b,a] a 0..255 "#rrggbb"/"#rrggbbaa"  */
function parseColor(color) {
	if (Array.isArray(color)) {
		if (color.length !== 3 && color.length !== 4) throw new Error(" [r,g,b]  [r,g,b,a]");
		const [r, g, b, a = 255] = color;
		for (const v of [r, g, b, a]) {
			if (!Number.isFinite(v) || v < 0 || v > 255) throw new Error(" 0..255 ");
		}
		return [r, g, b, a];
	}
	if (typeof color === "string") {
		const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
		if (!m) throw new Error(' "#rrggbb"  "#rrggbbaa"');
		const hex = m[1];
		return [
			parseInt(hex.slice(0, 2), 16),
			parseInt(hex.slice(2, 4), 16),
			parseInt(hex.slice(4, 6), 16),
			m[2] ? parseInt(m[2], 16) : 255,
		];
	}
	throw new Error(' [r,g,b,a]  "#rrggbb"/"#rrggbbaa" ');
}

/**  (w+2*width) × (h+2*width)  color */
export function addBorder(img, width, color) {
	assertImage(img);
	const b = Math.round(width);
	if (!Number.isFinite(b) || b < 0) throw new Error("");
	const [r, g, bl, a] = parseColor(color);
	const { width: w, height: h, data } = img;
	const out = newImage(w + b * 2, h + b * 2, img.hasAlpha || a < 255);
	const ow = out.width;
	//
	for (let i = 0; i < out.data.length; i += 4) {
		out.data[i] = r;
		out.data[i + 1] = g;
		out.data[i + 2] = bl;
		out.data[i + 3] = a;
	}
	for (let y = 0; y < h; y++) {
		const s = y * w * 4;
		const o = ((y + b) * ow + b) * 4;
		out.data.set(data.subarray(s, s + w * 4), o);
	}
	return out;
}

// ---------------------------------------------------------------------------
//
// ---------------------------------------------------------------------------

/**
 * bins  256 { r, g, b, luma } 0..1
 * luma  BT.709 0.2126R + 0.7152G + 0.0722B
 */
export function histogram(img, bins = 256) {
	assertImage(img);
	if (!Number.isInteger(bins) || bins <= 0 || bins > 65536) throw new Error(" 1..65536 ");
	const { data } = img;
	const r = new Float64Array(bins);
	const g = new Float64Array(bins);
	const b = new Float64Array(bins);
	const luma = new Float64Array(bins);
	for (let i = 0; i < data.length; i += 4) {
		r[Math.min(bins - 1, Math.floor((data[i] * bins) / 256))]++;
		g[Math.min(bins - 1, Math.floor((data[i + 1] * bins) / 256))]++;
		b[Math.min(bins - 1, Math.floor((data[i + 2] * bins) / 256))]++;
		const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
		luma[Math.min(bins - 1, Math.floor((y * bins) / 256))]++;
	}
	const norm = (arr) => {
		let max = 0;
		for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
		const out = new Array(bins);
		for (let i = 0; i < arr.length; i++) out[i] = max > 0 ? arr[i] / max : 0;
		return out;
	};
	return { r: norm(r), g: norm(g), b: norm(b), luma: norm(luma) };
}

/**
 *  4 4096  count
 * alpha < 8
 */
export function dominantColors(img, count = 6) {
	assertImage(img);
	if (!Number.isInteger(count) || count <= 0) throw new Error("");
	const { data } = img;
	const buckets = new Set();
	let total = 0;
	const rs = new Float64Array(4096);
	const gs = new Float64Array(4096);
	const bs = new Float64Array(4096);
	const ns = new Float64Array(4096);
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] < 8) continue;
		const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
		if (ns[key] === 0) buckets.add(key);
		rs[key] += data[i];
		gs[key] += data[i + 1];
		bs[key] += data[i + 2];
		ns[key]++;
		total++;
	}
	if (total === 0) return [];
	const keys = [...buckets].sort((a, b) => ns[b] - ns[a]).slice(0, count);
	return keys.map((k) => ({
		rgb: [Math.round(rs[k] / ns[k]), Math.round(gs[k] / ns[k]), Math.round(bs[k] / ns[k])],
		share: ns[k] / total,
	}));
}
