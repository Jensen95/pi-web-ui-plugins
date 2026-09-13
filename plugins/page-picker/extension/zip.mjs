export function crc32(bytes) {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc ^= bytes[i];
		for (let bit = 0; bit < 8; bit++) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

export function buildZip(entries) {
	const encoder = new TextEncoder();
	/** @type {Uint8Array[]} */
	const locals = [];
	/** @type {Uint8Array[]} */
	const centrals = [];
	let offset = 0;

	for (const entry of entries) {
		if (entry.name.startsWith("/") || entry.name.includes("..")) {
			throw new Error(`Invalid ZIP entry name (absolute paths and .. are not allowed): ${entry.name}`);
		}
		const nameBytes = encoder.encode(entry.name);
		const crc = crc32(entry.data);
		const size = entry.data.length;

		const local = new Uint8Array(30 + nameBytes.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(6, 0x0800, true);
		lv.setUint16(8, 0, true);
		lv.setUint16(10, DOS_TIME, true);
		lv.setUint16(12, DOS_DATE, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, size, true);
		lv.setUint32(22, size, true);
		lv.setUint16(26, nameBytes.length, true);
		lv.setUint16(28, 0, true);
		local.set(nameBytes, 30);
		locals.push(local, entry.data);

		const central = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, 0, true);
		cv.setUint16(12, DOS_TIME, true);
		cv.setUint16(14, DOS_DATE, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, size, true);
		cv.setUint32(24, size, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint16(30, 0, true); // extra
		cv.setUint16(32, 0, true); // comment
		cv.setUint16(34, 0, true);
		cv.setUint16(36, 0, true);
		cv.setUint32(38, 0, true);
		cv.setUint32(42, offset, true);
		central.set(nameBytes, 46);
		centrals.push(central);

		offset += local.length + size;
	}

	const centralSize = centrals.reduce((n, c) => n + c.length, 0);
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(4, 0, true);
	ev.setUint16(6, 0, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);
	ev.setUint16(20, 0, true);

	const out = new Uint8Array(offset + centralSize + eocd.length);
	let at = 0;
	for (const part of [...locals, ...centrals, eocd]) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

export function readZip(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	let eocd = -1;
	for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65536; i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("Invalid ZIP: end-of-central-directory record not found");
	const count = view.getUint16(eocd + 10, true);
	let cdOffset = view.getUint32(eocd + 16, true);
	const decoder = new TextDecoder();
	/** @type {ZipInfo["entries"]} */
	const entries = [];
	for (let i = 0; i < count; i++) {
		if (view.getUint32(cdOffset, true) !== 0x02014b50) throw new Error("Invalid ZIP central directory");
		const crc = view.getUint32(cdOffset + 16, true);
		const size = view.getUint32(cdOffset + 24, true);
		const nameLen = view.getUint16(cdOffset + 28, true);
		const extraLen = view.getUint16(cdOffset + 30, true);
		const commentLen = view.getUint16(cdOffset + 32, true);
		const name = decoder.decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen));
		entries.push({ name, size, crc });
		cdOffset += 46 + nameLen + extraLen + commentLen;
	}
	return { entries };
}
