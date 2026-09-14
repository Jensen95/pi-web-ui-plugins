/**
 * Reload the repository's custom plugin catalog through the host terminal.
 *
 * The plugin API has no supported catalog write or reload method, so this view
 * intentionally uses the private event the host already exposes for plugin
 * update buttons. The command fetches, validates and writes the custom catalog,
 * then installs every listed source with the host CLI.
 */

export const CATALOG_URL = "https://raw.githubusercontent.com/Jensen95/pi-web-ui-plugins/main/plugins/catalog.json";
export const EVENT_NAME = "pi-web-ui:plugin-run-command";
export const COMMAND_TITLE = "Reload custom plugins";
const SELF_SOURCE = "Jensen95/pi-web-ui-plugins/plugins/catalog-sync";

const COMMAND_SCRIPT = `
const response = await fetch(${JSON.stringify(CATALOG_URL)}, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error("catalog request failed: HTTP " + response.status);
const entries = await response.json();
if (!Array.isArray(entries) || entries.length === 0) throw new Error("catalog must be a non-empty JSON array");
const ids = new Set();
for (const entry of entries) {
  const source = entry && typeof entry === "object" ? entry.source : undefined;
  const id = entry && typeof entry === "object" ? entry.id : undefined;
  const isUrl = typeof source === "string" && (source.startsWith("http://") || source.startsWith("https://")) && !/\\s/.test(source);
  const isRepo = typeof source === "string" && /^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+(?:\\/[A-Za-z0-9_.-]+)*(?:#[A-Za-z0-9_.-]+)?$/.test(source);
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id) || typeof source !== "string" || source.trim() === "" || (!isUrl && !isRepo)) {
    throw new Error("catalog contains an invalid plugin id or source");
  }
  if (ids.has(id)) throw new Error("catalog contains duplicate plugin id: " + id);
  ids.add(id);
}
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const childProcess = await import("node:child_process");
const configured = process.env.PI_WEB_DATA_DIR?.trim();
const dataDir = configured || path.join(os.homedir(), ".pi-web");
for (const entry of entries) {
  if (entry.id === "catalog-sync") continue;
  const cli = process.platform === "win32" ? "pi-web-ui.cmd" : "pi-web-ui";
  const result = childProcess.spawnSync(cli, ["install", entry.source.trim(), "--name", entry.id, "--force"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
fs.mkdirSync(dataDir, { recursive: true });
const catalogPath = path.join(dataDir, "plugin-catalog.json");
const temporaryPath = catalogPath + ".tmp-" + process.pid;
try {
  fs.writeFileSync(temporaryPath, JSON.stringify({ entries }, null, 2) + "\\n");
  fs.renameSync(temporaryPath, catalogPath);
} catch (error) {
  try { fs.unlinkSync(temporaryPath); } catch {}
  throw error;
}
`;

/** The visible command run by the host's terminal bridge. */
export function reloadCommand(): string {
	const encodedScript = btoa(COMMAND_SCRIPT);
	return `pi-web-ui install ${SELF_SOURCE} --name catalog-sync --force && node --input-type=module -e "eval(Buffer.from('${encodedScript}', 'base64').toString())"`;
}

/** The narrow browser view contract supplied by pi-web-ui. */
export interface ViewContext {
	pluginId: string;
	send(payload: unknown): void;
	onData(cb: (payload: unknown) => void): () => void;
}

function setStatus(status: HTMLElement, text: string): void {
	status.textContent = text;
}

const clientEntry = {
	mount(container: HTMLElement): () => void {
		const document = container.ownerDocument;
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = COMMAND_TITLE;

		const status = document.createElement("p");
		status.textContent = "Ready.";

		const onClick = (): void => {
			const view = document.defaultView;
			if (!view || typeof view.dispatchEvent !== "function") {
				setStatus(status, "The terminal bridge is unavailable.");
				return;
			}
			try {
				view.dispatchEvent(
					new CustomEvent(EVENT_NAME, {
						detail: { title: COMMAND_TITLE, command: reloadCommand() },
					}),
				);
				setStatus(status, "Reload request sent to the terminal.");
			} catch {
				setStatus(status, "Could not start the reload command.");
			}
		};

		button.addEventListener("click", onClick);
		container.append(button, status);
		return () => {
			button.removeEventListener("click", onClick);
			container.replaceChildren();
		};
	},
};

export default clientEntry;
