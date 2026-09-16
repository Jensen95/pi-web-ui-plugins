/** Focused coverage for the image-toolkit's dependency-free image helpers. */
import { describe, expect, it } from "vitest";
import { activatePlugin } from "../helpers/mock-host";
import imageToolkitServer from "../../plugins/image-toolkit/src/index";
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

describe("image-toolkit internal config", () => {
	it("migrates the legacy declarative settings once and clamps bad values", async () => {
		const { host } = await activatePlugin(imageToolkitServer, {
			permissions: ["fs", "http", "tools"],
			// The manifest no longer declares settings, so getSettings() is empty and the legacy
			// values only survive in the raw storage table under the old "settings" key.
			storage: { settings: { quality: 9, defaultFormat: "tiff", suffix: "-small", aiTools: false } },
		});

		expect(host.recorded.storage.get("config")).toMatchObject({
			quality: 1,
			defaultFormat: "keep",
			suffix: "-small",
			aiTools: false,
		});
		expect(host.recorded.agentTools.size).toBe(0);

		const res = await host.callRoute("POST", "/ws/settings", { body: { aiTools: true, maxDim: 99999 } });

		expect((res.body as { settings: Record<string, unknown> }).settings).toMatchObject({
			aiTools: true,
			maxDim: 20000,
		});
		expect(host.recorded.agentTools.has("image_info")).toBe(true);
		expect(host.recorded.broadcasts.at(-1)).toMatchObject({ kind: "settings" });
	});
});
