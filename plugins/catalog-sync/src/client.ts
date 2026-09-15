/**
 * One button: hand this repository's catalog to the host.
 *
 * pi-web-ui 0.86 added `host.reloadCatalog(source, { install, replace })`
 * (issue #148): the server fetches the document, validates it with the same
 * rules the marketplace "Add plugin" form uses, writes
 * <dataDir>/plugin-catalog.json atomically, reloads plugins and returns a
 * structured receipt. Nothing is written when the fetch or the shape fails, so
 * a failed sync leaves the previous catalog intact.
 *
 * Installing is deliberately NOT done here: the marketplace installs a
 * source-only plugin itself with its "Build from source" option (the UI
 * equivalent of `pi-web-ui install <source> --build`).
 */

export const CATALOG_URL = "https://raw.githubusercontent.com/Jensen95/pi-web-ui-plugins/main/plugins/catalog.json";
export const SYNC_TITLE = "Sync catalog";
/** The host API version that introduced reloadCatalog. */
const REQUIRED_API = 4;
const UPGRADE_HINT = `${SYNC_TITLE} needs pi-web-ui 0.86 or newer (host API ${REQUIRED_API}+).`;

interface CatalogReceipt {
	ok: boolean;
	error?: string;
	entries?: unknown[];
}

interface CatalogHost {
	version?: number;
	reloadCatalog(source: string, options?: { install?: boolean; replace?: boolean }): Promise<CatalogReceipt>;
}

/** The narrow browser view contract supplied by pi-web-ui. */
export interface ViewContext {
	pluginId: string;
	send(payload: unknown): void;
	onData(cb: (payload: unknown) => void): () => void;
}

function hostFrom(container: HTMLElement): CatalogHost | undefined {
	const view = container.ownerDocument.defaultView as (Window & { __piWebUiHost?: CatalogHost }) | null;
	const host = view?.__piWebUiHost;
	return typeof host?.reloadCatalog === "function" ? host : undefined;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The sentence shown for a receipt, so the user never has to read a console. */
export function describeReceipt(receipt: CatalogReceipt | undefined): string {
	if (!receipt?.ok) return `Catalog sync failed: ${receipt?.error ?? "the host reported no reason"}`;
	const count = receipt.entries?.length ?? 0;
	return `Catalog synced: ${count} plugins. Install them from Settings -> UI plugins, with "Build from source" ticked.`;
}

const VIEW_STYLE = `
.catalog-sync { display: grid; gap: 14px; width: min(100%, 720px); }
.catalog-sync h1 { margin: 0; font-size: 1.25rem; }
.catalog-sync p { margin: 0; opacity: .78; }
.catalog-sync button { cursor: pointer; justify-self: start; }
.catalog-sync code { overflow-wrap: anywhere; opacity: .7; font-size: .85em; }
.catalog-sync__rows { display: grid; gap: 8px; }
.catalog-sync__row { display: grid; gap: 4px; padding: 10px; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 8px; }
.catalog-sync__head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.catalog-sync__name { font-weight: 600; }
.catalog-sync__status { font-size: .85em; opacity: .8; }
.catalog-sync__status--update-available { opacity: 1; font-weight: 600; }
`;

type UpdateStatus = "update-available" | "current" | "unknown";

interface UpdateRow {
	id: string;
	name?: string;
	version?: string;
	status?: UpdateStatus;
	command?: string;
}

/** What each status means to a reader, in words rather than a colour. */
const STATUS_LABEL: Record<UpdateStatus, string> = {
	"update-available": "Update available",
	current: "Up to date",
	// Never "up to date": no marker or an unreachable remote is not good news.
	unknown: "Unknown - no install marker, or the remote could not be read",
};

function parseRows(value: unknown): UpdateRow[] {
	if (!Array.isArray(value)) return [];
	return value.filter((row): row is UpdateRow => typeof (row as UpdateRow)?.id === "string");
}

const clientEntry = {
	mount(container: HTMLElement, ctx: ViewContext): () => void {
		const document = container.ownerDocument;
		const create = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
			const element = document.createElement(tag);
			if (text !== undefined) element.textContent = text;
			return element;
		};

		const root = create("section");
		root.className = "catalog-sync";
		const style = create("style");
		style.textContent = VIEW_STYLE;
		const heading = create("h1", "Plugin catalog");
		const intro = create(
			"p",
			"Write this repository's plugin list into the pi-web-ui marketplace. Nothing is installed.",
		);
		const source = create("code", CATALOG_URL);
		const button = create("button", SYNC_TITLE);
		button.type = "button";
		const status = create("p", "Ready.");
		const updates = create("div");
		updates.className = "catalog-sync__rows";
		const updatesStatus = create("p", "Checking installed plugins...");

		const renderRows = (rows: UpdateRow[]): void => {
			if (rows.length === 0) {
				updatesStatus.textContent = "No plugins installed from a tracked source yet.";
				updates.replaceChildren();
				return;
			}
			const stale = rows.filter((row) => row.status === "update-available").length;
			updatesStatus.textContent =
				stale === 0
					? `${rows.length} installed plugins, none of them behind.`
					: `${stale} of ${rows.length} installed plugins have a newer source.`;
			updates.replaceChildren(
				...rows.map((row) => {
					const card = create("article");
					card.className = "catalog-sync__row";
					const head = create("div");
					head.className = "catalog-sync__head";
					const name = create("span", row.name ?? row.id);
					name.className = "catalog-sync__name";
					head.append(name);
					if (row.version) head.append(create("span", `v${row.version}`));
					const state = row.status ?? "unknown";
					const label = create("span", STATUS_LABEL[state] ?? STATUS_LABEL.unknown);
					label.className = `catalog-sync__status catalog-sync__status--${state}`;
					head.append(label);
					card.append(head);
					// Only the stale rows carry a command: this plugin cannot run the
					// update itself, because the install path it can reach never builds.
					if (state === "update-available" && row.command) card.append(create("code", row.command));
					return card;
				}),
			);
		};

		let syncing = false;
		let disposed = false;

		const onClick = (): void => {
			if (syncing) return;
			const host = hostFrom(container);
			if (!host) {
				status.textContent = UPGRADE_HINT;
				return;
			}
			syncing = true;
			button.disabled = true;
			status.textContent = "Syncing catalog...";
			void Promise.resolve(host.reloadCatalog(CATALOG_URL, { replace: true }))
				.then((receipt) => describeReceipt(receipt))
				.catch((error: unknown) => `Catalog sync failed: ${messageOf(error)}`)
				.then((text) => {
					if (disposed) return;
					status.textContent = text;
					syncing = false;
					button.disabled = false;
				});
		};

		button.addEventListener("click", onClick);
		const off = ctx.onData((payload: unknown) => {
			const message = payload as { kind?: unknown; rows?: unknown };
			if (disposed || message?.kind !== "updates") return;
			renderRows(parseRows(message.rows));
		});
		root.append(style, heading, intro, source, button, status, updatesStatus, updates);
		container.append(root);
		ctx.send({ action: "check_updates" });

		return () => {
			disposed = true;
			off();
			button.removeEventListener("click", onClick);
			container.replaceChildren();
		};
	},
};

export default clientEntry;
