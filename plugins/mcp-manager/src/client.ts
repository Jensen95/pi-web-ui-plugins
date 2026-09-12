/**
 * mcp-manager browser view.
 *
 * Compiled to client/entry.mjs and loaded by the browser as bare ESM, so this
 * file may not import anything at runtime: plain DOM only, and the config types
 * come in as a type-only import that esbuild erases.
 *
 * The view is a thin surface over the server entry's message protocol: it asks
 * for state on mount, renders the effective servers with their provenance, and
 * sends toggle/add/remove actions. It never sees a credential value - the
 * server masks them before they leave the process.
 */
import type { ClientServer, ClientState, ErrorMessage, McpServerEntry, StateMessage } from "./config.ts";

/** The narrow channel the host gives a view. */
export interface ViewContext {
	pluginId: string;
	send(payload: unknown): void;
	onData(cb: (payload: unknown) => void): () => void;
}

const STYLES = `
.mcp-manager { padding: 12px; color: inherit; font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; }
.mcp-manager h3 { margin: 0 0 4px; font-size: 15px; }
.mcp-manager h4 { margin: 0 0 6px; font-size: 13px; }
.mcp-manager .hint { margin: 0 0 10px; opacity: 0.75; }
.mcp-manager code { padding: 0 4px; border-radius: 3px; background: rgba(127, 127, 127, 0.18); }
.mcp-manager section { margin-top: 18px; }
.mcp-manager table { width: 100%; border-collapse: collapse; }
.mcp-manager th, .mcp-manager td { padding: 4px 8px; border-bottom: 1px solid rgba(127, 127, 127, 0.25); text-align: left; vertical-align: top; }
.mcp-manager td.name { font-weight: 600; white-space: nowrap; }
.mcp-manager td.actions { white-space: nowrap; text-align: right; }
.mcp-manager .muted { opacity: 0.7; }
.mcp-manager .off { opacity: 0.55; }
.mcp-manager .error { margin: 6px 0; color: #e5484d; white-space: pre-wrap; }
.mcp-manager button { padding: 2px 8px; border: 1px solid rgba(127, 127, 127, 0.5); border-radius: 4px; background: rgba(127, 127, 127, 0.12); color: inherit; font: inherit; cursor: pointer; }
.mcp-manager button + button { margin-left: 6px; }
.mcp-manager form { display: grid; gap: 8px; max-width: 620px; }
.mcp-manager label { display: grid; gap: 2px; }
.mcp-manager input, .mcp-manager textarea { padding: 3px 6px; border: 1px solid rgba(127, 127, 127, 0.4); border-radius: 4px; background: rgba(127, 127, 127, 0.08); color: inherit; font: inherit; }
.mcp-manager ul { margin: 0; padding: 0; list-style: none; }
`;

/** One argument per line, so an argument may contain spaces. */
export function parseArgsText(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

/** KEY=VALUE per line. Unparsable lines are reported, never dropped silently. */
export function parseEnvText(text: string): { env: Record<string, string>; rejected: string[] } {
	const env: Record<string, string> = {};
	const rejected: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const equals = trimmed.indexOf("=");
		const key = equals === -1 ? "" : trimmed.slice(0, equals).trim();
		if (key === "") {
			rejected.push(trimmed);
			continue;
		}
		env[key] = trimmed.slice(equals + 1).trim();
	}
	return { env, rejected };
}

/** One line a human can read instead of a JSON blob. */
export function summarizeEntry(entry: McpServerEntry): string {
	if (typeof entry.url === "string" && entry.url !== "") return entry.url;
	if (typeof entry.command === "string" && entry.command !== "") {
		const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
		return [entry.command, ...args].join(" ");
	}
	return "(no command or url)";
}

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
	const node = el("button", undefined, label) as HTMLButtonElement;
	node.type = "button";
	node.addEventListener("click", onClick);
	return node;
}

/** One labelled form control appended to the form. */
function appendField(form: HTMLElement, labelText: string, input: HTMLElement): void {
	const label = el("label");
	label.append(el("span", "muted", labelText), input);
	form.append(label);
}

/** Masked credentials still have keys worth showing, values are not. */
function describeSecrets(entry: McpServerEntry): string {
	const parts: string[] = [];
	for (const field of ["env", "headers"] as const) {
		const record = entry[field];
		if (record && typeof record === "object") parts.push(`${field}: ${Object.keys(record).join(", ")}`);
	}
	if (typeof entry.bearerToken === "string") parts.push("bearer token set");
	return parts.join(" - ");
}

function serverRow(server: ClientServer, send: (payload: unknown) => void): HTMLTableRowElement {
	const row = el("tr", server.disabled ? "off" : undefined) as HTMLTableRowElement;

	const name = el("td", "name", server.name) as HTMLTableCellElement;
	if (server.layers.length > 1) {
		name.append(" ", el("span", "muted", `(defined in ${server.layers.length} layers)`));
	}
	row.append(name);

	const definition = el("td") as HTMLTableCellElement;
	definition.append(el("div", undefined, summarizeEntry(server.entry)));
	const secrets = describeSecrets(server.entry);
	if (secrets !== "") definition.append(el("div", "muted", secrets));
	row.append(definition);

	const source = el("td", "muted") as HTMLTableCellElement;
	source.append(el("div", undefined, server.source.label));
	source.append(el("div", undefined, server.source.path));
	row.append(source);

	const status = el("td", undefined, server.disabled ? "disabled" : "enabled") as HTMLTableCellElement;
	row.append(status);

	const actions = el("td", "actions") as HTMLTableCellElement;
	actions.append(
		button(server.disabled ? "Enable" : "Disable", () =>
			send({ action: "toggle", name: server.name, disabled: !server.disabled }),
		),
	);
	// Only the project Pi override is writable, so that is the only place a
	// server can be removed from. Anything else has to be disabled instead.
	if (server.source.writable) {
		actions.append(button("Remove", () => send({ action: "remove", name: server.name })));
	}
	row.append(actions);
	return row;
}

function serversSection(state: ClientState, send: (payload: unknown) => void): HTMLElement {
	const section = el("section");
	section.append(el("h4", undefined, `Servers (${state.servers.length})`));
	if (state.servers.length === 0) {
		section.append(
			el(
				"p",
				"muted",
				"No MCP servers are configured in any layer. Add one below, or run /mcp setup in pi to import from another tool.",
			),
		);
		return section;
	}
	const table = el("table") as HTMLTableElement;
	const head = el("tr") as HTMLTableRowElement;
	for (const label of ["Server", "Definition", "Comes from", "State", ""]) head.append(el("th", undefined, label));
	table.append(head);
	for (const server of state.servers) table.append(serverRow(server, send));
	section.append(table);
	return section;
}

function addSection(send: (payload: unknown) => void): HTMLElement {
	const section = el("section");
	section.append(el("h4", undefined, "Add a server"));
	section.append(el("p", "hint", "Written to the project Pi override, .pi/mcp.json."));

	const form = el("form") as HTMLFormElement;
	const error = el("div", "error");
	error.hidden = true;

	function textField(labelText: string, hint: string): HTMLInputElement {
		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = hint;
		appendField(form, labelText, input);
		return input;
	}

	function areaField(labelText: string, hint: string): HTMLTextAreaElement {
		const input = document.createElement("textarea");
		input.rows = 3;
		input.placeholder = hint;
		appendField(form, labelText, input);
		return input;
	}

	const name = textField("Name", "my-server");
	const command = textField("Command", "npx");
	const args = areaField("Arguments (one per line)", "-y\nsome-mcp-server");
	const url = textField("URL (remote server, leave empty for a command)", "https://example.com/mcp");
	const env = areaField("Environment (KEY=VALUE per line)", "API_KEY=...");

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		error.hidden = true;

		const serverName = name.value.trim();
		const commandText = command.value.trim();
		const urlText = url.value.trim();
		const parsedArgs = parseArgsText(args.value);
		const parsedEnv = parseEnvText(env.value);

		let rejected = "";
		if (serverName === "") rejected = "A server name is required.";
		else if (commandText !== "" && urlText !== "") rejected = "Choose either a command or a URL, not both.";
		else if (commandText === "" && urlText === "") rejected = "A command or a URL is required.";
		else if (parsedEnv.rejected.length > 0) {
			rejected = `These environment lines are not KEY=VALUE:\n${parsedEnv.rejected.join("\n")}`;
		}
		if (rejected !== "") {
			error.textContent = rejected;
			error.hidden = false;
			return;
		}

		const entry: McpServerEntry =
			urlText !== ""
				? { url: urlText }
				: {
						command: commandText,
						...(parsedArgs.length > 0 ? { args: parsedArgs } : {}),
						...(Object.keys(parsedEnv.env).length > 0 ? { env: parsedEnv.env } : {}),
					};
		send({ action: "add", name: serverName, entry });
	});

	const submit = el("button", undefined, "Add server") as HTMLButtonElement;
	submit.type = "submit";
	form.append(submit, error);
	section.append(form);
	return section;
}

function layersSection(state: ClientState): HTMLElement {
	const section = el("section");
	section.append(el("h4", undefined, "Config layers (lowest precedence first)"));
	const list = el("ul");
	for (const layer of state.layers) {
		const item = el("li", layer.exists ? undefined : "muted");
		const detail = layer.exists ? `${layer.serverCount} server(s)` : "not present";
		item.append(el("span", undefined, `${layer.label} - ${layer.path} - ${detail}`));
		if (layer.writable) item.append(" ", el("span", "muted", "(written by this plugin)"));
		if (layer.error) item.append(" ", el("span", "error", layer.error.message));
		list.append(item);
	}
	section.append(list);
	return section;
}

export default {
	mount(container: HTMLElement, ctx: ViewContext): () => void {
		const root = el("div", "mcp-manager");
		const style = el("style");
		style.textContent = STYLES;
		const error = el("div", "error");
		error.hidden = true;
		const body = el("div");
		root.append(style, error, body);
		container.append(root);

		const send = (payload: unknown): void => ctx.send(payload);

		function render(state: ClientState): void {
			error.hidden = true;
			const header = el("div");
			const title = el("h3", undefined, "MCP servers");
			const hint = el("p", "hint");
			hint.append(
				"Read from the pi-mcp-adapter config layers; changes are written to ",
				el("code", undefined, state.projectOverridePath),
				" only. Run ",
				el("code", undefined, "/reload"),
				" in pi to apply them.",
			);
			const actions = el("div");
			actions.append(button("Refresh", () => send({ action: "list" })));
			header.append(title, hint, actions);
			body.replaceChildren(header, serversSection(state, send), addSection(send), layersSection(state));
		}

		function showError(message: string): void {
			error.textContent = message;
			error.hidden = false;
		}

		const off = ctx.onData((payload) => {
			const message = payload as StateMessage | ErrorMessage | null | undefined;
			if (message?.type === "state") render(message.state);
			else if (message?.type === "error") showError(`${message.action} failed: ${message.message}`);
		});

		send({ action: "list" });
		return () => {
			off();
			root.remove();
		};
	},
};
