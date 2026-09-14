/**
 * Reload the repository's custom plugin catalog through the host terminal.
 *
 * The plugin API has no supported catalog write or reload method, so this view
 * intentionally uses the private event the host already exposes for plugin
 * update buttons. The command fetches, validates and writes the custom catalog,
 * then builds and installs every listed source with the host CLI.
 */

export const CATALOG_URL = "https://raw.githubusercontent.com/Jensen95/pi-web-ui-plugins/main/plugins/catalog.json";
export const SOURCE_REPOSITORY = "Jensen95/pi-web-ui-plugins";
export const EVENT_NAME = "pi-web-ui:plugin-run-command";
export const COMMAND_TITLE = "Reload custom plugins";
const SELF_SOURCE = `${SOURCE_REPOSITORY}/plugins/catalog-sync`;

const COMMAND_SCRIPT = `
const response = await fetch(${JSON.stringify(CATALOG_URL)}, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error("catalog request failed: HTTP " + response.status);
const entries = await response.json();
if (!Array.isArray(entries) || entries.length === 0) throw new Error("catalog must be a non-empty JSON array");
const sourcePrefix = ${JSON.stringify(`${SOURCE_REPOSITORY}/plugins/`)};
const ids = new Set();
for (const entry of entries) {
  const source = entry && typeof entry === "object" ? entry.source : undefined;
  const id = entry && typeof entry === "object" ? entry.id : undefined;
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(id) ||
    typeof source !== "string" ||
    source.trim() !== sourcePrefix + id
  ) {
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
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const cli = process.platform === "win32" ? "pi-web-ui.cmd" : "pi-web-ui";
const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-plugins-"));
const run = (command, args, cwd) => {
  const result = childProcess.spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + " failed with exit code " + (result.status ?? "unknown"));
};
try {
  run("git", ["clone", "--depth", "1", ${JSON.stringify(`https://github.com/${SOURCE_REPOSITORY}.git`)}, checkout]);
  run(npm, ["ci"], checkout);
  run(npm, ["run", "build"], checkout);

  for (const entry of entries) {
    const pluginDir = path.join(checkout, "plugins", entry.id);
    const hasManifest = fs.existsSync(path.join(pluginDir, "manifest.json"));
    const hasServerEntry = fs.existsSync(path.join(pluginDir, "index.mjs"));
    const hasClientEntry = fs.existsSync(path.join(pluginDir, "client", "entry.mjs"));
    if (!hasManifest || (!hasServerEntry && !hasClientEntry)) {
      throw new Error("build did not produce a runnable plugin: " + entry.id);
    }
  }
  for (const entry of entries) {
    if (entry.id === "catalog-sync") continue;
    run(cli, ["install", path.join(checkout, "plugins", entry.id), "--name", entry.id, "--force"]);
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
} finally {
  fs.rmSync(checkout, { recursive: true, force: true });
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
