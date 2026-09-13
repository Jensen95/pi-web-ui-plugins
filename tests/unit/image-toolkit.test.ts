/** Focused coverage for the image-toolkit's dependency-free image helpers. */
import { describe, expect, it } from "vitest";
import { encodeImage, sniffFormat } from "../../plugins/image-toolkit/src/codec";
import { cropImage, flipImage, resizeImage, rotateImage } from "../../plugins/image-toolkit/src/ops";
import { probeImage } from "../../plugins/image-toolkit/src/probe";

const sample = {
	width: 2,
	height: 1,
	data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]),
	format: "png",
	hasAlpha: true,
};

describe("image-toolkit helpers", () => {
	it("round-trips a PNG and reports its dimensions", async () => {
		const encoded = await encodeImage(sample, "png");

		expect(sniffFormat(encoded)).toBe("png");
		expect(probeImage(encoded)).toMatchObject({ format: "png", width: 2, height: 1, hasAlpha: true });
	});

	it("keeps pixel operations within their documented dimensions", () => {
		expect(resizeImage(sample, { width: 4, height: 2 })).toMatchObject({ width: 4, height: 2 });
		expect((cropImage as any)(sample, { x: 1, y: 0, width: 1, height: 1 })).toMatchObject({ width: 1, height: 1 });
		expect(rotateImage(sample, 90)).toMatchObject({ width: 1, height: 2 });
		expect(flipImage(sample, "h")).toMatchObject({ width: 2, height: 1 });
	});
});
