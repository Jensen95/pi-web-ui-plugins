/**
 * Manage this repository's custom plugin catalog through the host terminal.
 *
 * The plugin API has no supported catalog-write or reload method, so this view
 * intentionally uses the private event the host already exposes for plugin
 * update buttons. Catalog sync and plugin installation stay separate actions.
 */

export const CATALOG_URL = "https://raw.githubusercontent.com/Jensen95/pi-web-ui-plugins/main/plugins/catalog.json";
export const SOURCE_REPOSITORY = "Jensen95/pi-web-ui-plugins";
export const EVENT_NAME = "pi-web-ui:plugin-run-command";
export const SYNC_TITLE = "Sync catalog";
export const UPDATE_TITLE = "Install/update selected";
/** Kept for hosts or callers that used the old exported title. */
export const COMMAND_TITLE = UPDATE_TITLE;
const SELF_SOURCE = `${SOURCE_REPOSITORY}/plugins/catalog-sync`;
const SOURCE_PREFIX = `${SOURCE_REPOSITORY}/plugins/`;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const CATALOG_FILE_SCRIPT = `
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const configured = process.env.PI_WEB_DATA_DIR?.trim();
const dataDir = configured || path.join(os.homedir(), ".pi-web");
const writeCatalog = (catalogEntries) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const catalogPath = path.join(dataDir, "plugin-catalog.json");
  const temporaryPath = catalogPath + ".tmp-" + process.pid;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify({ entries: catalogEntries }, null, 2) + "\\n");
    fs.renameSync(temporaryPath, catalogPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
};
`;

const CATALOG_SCRIPT = (body: string): string => `
const response = await fetch(${JSON.stringify(CATALOG_URL)}, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error("catalog request failed: HTTP " + response.status);
const entries = await response.json();
if (!Array.isArray(entries) || entries.length === 0) throw new Error("catalog must be a non-empty JSON array");
const sourcePrefix = ${JSON.stringify(SOURCE_PREFIX)};
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
${body}
`;

const SYNC_SCRIPT = CATALOG_SCRIPT(`
${CATALOG_FILE_SCRIPT}
writeCatalog(entries);
`);

const UPDATE_SCRIPT = (requestedIds: string[] | undefined): string =>
	CATALOG_SCRIPT(`
const requestedIds = ${JSON.stringify(requestedIds ?? null)};
const selectedIds = new Set(requestedIds ?? ids);
if (selectedIds.size === 0) throw new Error("select at least one plugin");
for (const id of selectedIds) {
  if (!ids.has(id)) throw new Error("selected plugin is not in the catalog: " + id);
}
${CATALOG_FILE_SCRIPT}
const childProcess = await import("node:child_process");
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
    if (!selectedIds.has(entry.id) || entry.id === "catalog-sync") continue;
    run(cli, ["install", path.join(checkout, "plugins", entry.id), "--name", entry.id, "--force"]);
  }
  writeCatalog(entries);
} finally {
  fs.rmSync(checkout, { recursive: true, force: true });
}
`);

function nodeCommand(script: string): string {
	const encodedScript = btoa(`(async () => {${script}})()`);
	return `node --input-type=module -e "await eval(Buffer.from('${encodedScript}', 'base64').toString())"`;
}

/** Write the remote catalog without installing or updating any plugin. */
export function syncCatalogCommand(): string {
	return nodeCommand(SYNC_SCRIPT);
}

/** Build and install only the requested catalog entries. */
export function updateSelectedCommand(requestedIds?: string[]): string {
	const selfUpdate =
		requestedIds === undefined || requestedIds.includes("catalog-sync")
			? `pi-web-ui install ${SELF_SOURCE} --name catalog-sync --force && `
			: "";
	return `${selfUpdate}${nodeCommand(UPDATE_SCRIPT(requestedIds))}`;
}

/** Backward-compatible alias for callers using the original command name. */
export function reloadCommand(requestedIds?: string[]): string {
	return updateSelectedCommand(requestedIds);
}

/** The narrow browser view contract supplied by pi-web-ui. */
export interface ViewContext {
	pluginId: string;
	send(payload: unknown): void;
	onData(cb: (payload: unknown) => void): () => void;
}

interface CatalogEntry {
	id: string;
	source: string;
	name: string;
	icon?: string;
	description?: string;
	homepage?: string;
}

function parseCatalog(value: unknown): CatalogEntry[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("catalog must be a non-empty JSON array");
	const ids = new Set<string>();
	return value.map((item): CatalogEntry => {
		if (!item || typeof item !== "object") throw new Error("catalog contains an invalid plugin entry");
		const entry = item as Record<string, unknown>;
		const id = entry.id;
		const source = entry.source;
		if (
			typeof id !== "string" ||
			!ID_PATTERN.test(id) ||
			typeof source !== "string" ||
			source.trim() !== SOURCE_PREFIX + id ||
			ids.has(id)
		) {
			throw new Error("catalog contains an invalid plugin id or source");
		}
		ids.add(id);
		return {
			id,
			source,
			name: typeof entry.name === "string" && entry.name.trim() ? entry.name : id,
			icon: typeof entry.icon === "string" ? entry.icon : undefined,
			description: typeof entry.description === "string" ? entry.description : undefined,
			homepage: typeof entry.homepage === "string" ? entry.homepage : undefined,
		};
	});
}

async function fetchCatalog(): Promise<CatalogEntry[]> {
	const response = await fetch(CATALOG_URL);
	if (!response.ok) throw new Error(`catalog request failed: HTTP ${response.status}`);
	return parseCatalog(await response.json());
}

const VIEW_STYLE = `
.catalog-sync { display: grid; gap: 14px; max-width: 760px; }
.catalog-sync__header { display: grid; gap: 4px; }
.catalog-sync__header h1 { margin: 0; font-size: 1.25rem; }
.catalog-sync__header p, .catalog-sync__status { margin: 0; opacity: .75; }
.catalog-sync__actions { display: grid; grid-template-columns: max-content max-content 1fr; gap: 8px; align-items: center; }
.catalog-sync__actions button { cursor: pointer; }
.catalog-sync__selection { justify-self: end; opacity: .7; font-size: .9em; }
.catalog-sync__cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 10px; align-items: stretch; }
.catalog-sync__card { display: grid; height: 100%; box-sizing: border-box; padding: 12px; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 8px; }
.catalog-sync__card > label { display: grid; grid-template-columns: auto 1fr; gap: 10px; cursor: pointer; }
.catalog-sync__card input { margin-top: 4px; }
.catalog-sync__body { display: grid; gap: 5px; min-width: 0; }
.catalog-sync__body h2 { margin: 0; font-size: 1rem; }
.catalog-sync__body p { margin: 0; opacity: .8; }
.catalog-sync__source { overflow-wrap: anywhere; opacity: .65; font-size: .85em; }
@media (max-width: 560px) {
  .catalog-sync__actions { grid-template-columns: 1fr 1fr; }
  .catalog-sync__selection { grid-column: 1 / -1; justify-self: start; }
}
`;

function setStatus(status: HTMLElement, text: string): void {
	status.textContent = text;
}

const clientEntry = {
	mount(container: HTMLElement): () => void {
		const document = container.ownerDocument;
		const root = document.createElement("section");
		root.className = "catalog-sync";
		const style = document.createElement("style");
		style.textContent = VIEW_STYLE;

		const header = document.createElement("header");
		header.className = "catalog-sync__header";
		const heading = document.createElement("h1");
		heading.textContent = "Plugin catalog";
		const intro = document.createElement("p");
		intro.textContent = "Sync the catalog separately, or install and update the plugins you choose.";
		header.append(heading, intro);

		const actions = document.createElement("div");
		actions.className = "catalog-sync__actions";
		const syncButton = document.createElement("button");
		syncButton.type = "button";
		syncButton.textContent = SYNC_TITLE;
		syncButton.disabled = true;
		const updateButton = document.createElement("button");
		updateButton.type = "button";
		updateButton.textContent = UPDATE_TITLE;
		updateButton.disabled = true;
		const selection = document.createElement("span");
		selection.className = "catalog-sync__selection";
		selection.textContent = "0 selected";
		actions.append(syncButton, updateButton, selection);

		const status = document.createElement("p");
		status.className = "catalog-sync__status";
		status.textContent = "Loading plugin catalog…";
		const cards = document.createElement("div");
		cards.className = "catalog-sync__cards";
		const checkboxes: HTMLInputElement[] = [];
		const checkboxCleanups: Array<() => void> = [];
		const selectedIds = new Set<string>();
		let entries: CatalogEntry[] = [];
		let loaded = false;
		let disposed = false;

		const updateSelection = (): void => {
			selection.textContent = `${selectedIds.size} selected`;
			updateButton.disabled = !loaded || selectedIds.size === 0;
		};

		const sendCommand = (title: string, command: string, success: string): void => {
			const view = document.defaultView;
			if (!view || typeof view.dispatchEvent !== "function") {
				setStatus(status, "The terminal bridge is unavailable.");
				return;
			}
			try {
				view.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { title, command } }));
				setStatus(status, success);
			} catch {
				setStatus(status, "Could not start the terminal command.");
			}
		};

		const onSync = (): void => {
			if (!loaded) return;
			sendCommand(SYNC_TITLE, syncCatalogCommand(), "Catalog sync request sent to the terminal.");
		};
		const onUpdate = (): void => {
			if (selectedIds.size === 0) {
				setStatus(status, "Select at least one plugin.");
				return;
			}
			const requestedIds = entries.filter((entry) => selectedIds.has(entry.id)).map((entry) => entry.id);
			sendCommand(UPDATE_TITLE, updateSelectedCommand(requestedIds), "Install/update request sent to the terminal.");
		};

		syncButton.addEventListener("click", onSync);
		updateButton.addEventListener("click", onUpdate);
		root.append(style, header, actions, status, cards);
		container.append(root);

		void fetchCatalog()
			.then((loadedEntries) => {
				if (disposed) return;
				entries = loadedEntries;
				for (const entry of entries) {
					const card = document.createElement("article");
					card.className = "catalog-sync__card";
					const label = document.createElement("label");
					const checkbox = document.createElement("input");
					checkbox.type = "checkbox";
					checkbox.value = entry.id;
					const body = document.createElement("div");
					body.className = "catalog-sync__body";
					if (entry.icon) {
						const icon = document.createElement("span");
						icon.textContent = entry.icon;
						body.append(icon);
					}
					const title = document.createElement("h2");
					title.textContent = entry.name;
					const id = document.createElement("code");
					id.textContent = entry.id;
					const description = document.createElement("p");
					description.textContent = entry.description ?? "No description provided.";
					const source = document.createElement("code");
					source.className = "catalog-sync__source";
					source.textContent = entry.source;
					body.append(title, id, description, source);
					if (entry.homepage) {
						const homepage = document.createElement("a");
						homepage.href = entry.homepage;
						homepage.target = "_blank";
						homepage.rel = "noreferrer";
						homepage.textContent = "Repository";
						body.append(homepage);
					}
					label.append(checkbox, body);
					card.append(label);
					cards.append(card);
					checkboxes.push(checkbox);
					const onCheckbox = (): void => {
						if (checkbox.checked) selectedIds.add(entry.id);
						else selectedIds.delete(entry.id);
						updateSelection();
					};
					checkbox.addEventListener("click", onCheckbox);
					checkboxCleanups.push(() => checkbox.removeEventListener("click", onCheckbox));
				}
				loaded = true;
				syncButton.disabled = false;
				updateSelection();
				setStatus(status, "Catalog loaded. Choose an action.");
			})
			.catch(() => {
				if (disposed) return;
				setStatus(status, "Could not load the plugin catalog.");
			});

		return () => {
			disposed = true;
			syncButton.removeEventListener("click", onSync);
			updateButton.removeEventListener("click", onUpdate);
			for (const cleanup of checkboxCleanups) cleanup();
			container.replaceChildren();
		};
	},
};

export default clientEntry;
