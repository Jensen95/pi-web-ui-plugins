/**
 * webmail browser view - the mail management interface.
 *
 * Layout: a message list on the left (toolbar plus list), a reading pane on the
 * right; settings and compose are both modals. Plain DOM, with no dependency on
 * the host application's React. ctx.send() carries plugin_message upstream and
 * ctx.onData() subscribes to plugin_data; the protocol is defined by the
 * onMessage branches in index.ts. Styles are inline in a <style> element and the
 * colours come from the host application's CSS variables, so theme switching
 * follows automatically.
 */
import type { MailSummary, PublicConfig, PublicState, ReadMail } from "./index";
import { STATUS_FAILED_PREFIX } from "./protocol";

/** The narrow channel the frontend hands a plugin view. */
export interface ViewContext {
	pluginId: string;
	send(payload: unknown): void;
	onData(cb: (payload: unknown) => void): () => void;
}

/** Server -> view payloads; see the broadcast calls in index.ts. */
interface ServerMessage {
	kind?: string;
	state?: PublicState;
	config?: PublicConfig;
	mails?: MailSummary[];
	mail?: ReadMail;
	action?: string;
}

/** The settings form, addressed by the `name` attributes in the template below. */
interface SettingsForm extends HTMLFormElement {
	imapHost: HTMLInputElement;
	imapPort: HTMLInputElement;
	imapUser: HTMLInputElement;
	imapPass: HTMLInputElement;
	imapTls: HTMLInputElement;
	smtpHost: HTMLInputElement;
	smtpPort: HTMLInputElement;
	smtpUser: HTMLInputElement;
	smtpPass: HTMLInputElement;
	smtpFrom: HTMLInputElement;
	smtpTls: HTMLInputElement;
	pollSec: HTMLInputElement;
	notifyEnabled: HTMLInputElement;
	aiEnabled: HTMLInputElement;
}

/** The compose form, addressed the same way. */
interface ComposeForm extends HTMLFormElement {
	to: HTMLInputElement;
	subject: HTMLInputElement;
	body: HTMLTextAreaElement;
}

/** Escape the five characters that could break out of an element or attribute. */
export function esc(value: unknown): string {
	return String(value ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
	);
}

/** Today's messages show a time; anything older shows a month and day. */
export function fmtDate(iso: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	const today = new Date();
	return d.toDateString() === today.toDateString()
		? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const EMPTY_READER = `<div class="empty-reader">\u{1f448} Select a message on the left to read it</div>`;

function setMarkup(element: Element, markup: string): void {
	if (typeof document.createRange !== "function" || typeof element.replaceChildren !== "function") {
		element.textContent = markup;
		return;
	}
	const range = document.createRange();
	range.selectNodeContents(element);
	element.replaceChildren(range.createContextualFragment(markup));
}

export default {
	mount(container: HTMLElement, ctx: ViewContext): () => void {
		setMarkup(container, `
<div class="wmx">
	<style>
		.wmx { max-width: 1100px; margin: 0 auto; font-size: 13px; display: grid; gap: 10px; }
		.wmx-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.wmx h2 { margin: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.wmx .chip {
			font-size: 11px; padding: 1px 8px; border-radius: 99px;
			border: 1px solid var(--border, #333); opacity: .85; font-weight: normal;
		}
		.wmx .chip.ok { color: var(--green, #4ade80); border-color: color-mix(in srgb, var(--green, #4ade80) 40%, transparent); }
		.wmx .chip.err { color: var(--red, #f87171); border-color: color-mix(in srgb, var(--red, #f87171) 40%, transparent); }
		.wmx .chip.badge { color: var(--amber, #fbbf24); }
		.wmx .head-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }
		.wmx button {
			background: var(--bg-elev1, #16161d); color: inherit;
			border: 1px solid var(--border, #333); border-radius: 6px;
			padding: 3px 10px; cursor: pointer; font: inherit; font-size: 12px;
		}
		.wmx .head-actions button { padding: 2px 9px; opacity: .85; }
		.wmx .head-actions button:hover { opacity: 1; border-color: var(--accent, #7c5cff); }
		.wmx .btn-compose { color: var(--accent, #7c5cff); border-color: color-mix(in srgb, var(--accent, #7c5cff) 45%, transparent); background: transparent; opacity: 1; }
		.wmx button.primary { background: var(--accent, #7c5cff); color: #fff; border-color: transparent; }
		.wmx button.danger:hover { color: var(--red, #f87171); border-color: var(--red, #f87171); }
		.wmx input, .wmx select, .wmx textarea {
			background: var(--bg-elev1, #16161d); color: inherit;
			border: 1px solid var(--border, #333); border-radius: 6px;
			padding: 5px 8px; font: inherit; font-size: 12px; resize: vertical;
		}
		.wmx .hint { opacity: .55; font-size: 11px; margin: -4px 0 0; }
		.wmx .hint button { padding: 1px 8px; }

		/* two-column layout */
		.wmx-body { display: grid; grid-template-columns: minmax(300px, 42%) 1fr; gap: 12px; align-items: start; }
		@media (max-width: 760px) { .wmx-body { grid-template-columns: 1fr; } }
		.pane-list { display: grid; gap: 8px; min-width: 0; }
		.wmx .toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
		.wmx .toolbar input[type="search"] { flex: 1; min-width: 120px; }
		.wmx ul.maillist {
			list-style: none; margin: 0; padding: 0; display: grid; gap: 5px;
			max-height: calc(100vh - 260px); max-height: calc(100dvh - 260px); overflow: auto;
		}
		.wmx ul.maillist li {
			border: 1px solid var(--border, #333); border-radius: 7px;
			padding: 6px 10px; cursor: pointer; display: grid;
			grid-template-columns: 1fr auto; gap: 2px 10px; align-items: baseline;
		}
		.wmx ul.maillist li:hover { border-color: var(--accent, #7c5cff); }
		.wmx ul.maillist li.active { border-color: var(--accent, #7c5cff); background: color-mix(in srgb, var(--accent, #7c5cff) 8%, transparent); }
		.wmx ul.maillist li.unread { border-left: 3px solid var(--amber, #fbbf24); }
		.wmx ul.maillist .from {
			font-size: 12px; opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.wmx ul.maillist .subj {
			grid-column: 1 / -1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.wmx ul.maillist .date { opacity: .5; font-size: 11px; white-space: nowrap; }
		.wmx .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--amber, #fbbf24); margin-right: 5px; }

		/* right-hand reading pane */
		.wmx .reader {
			border: 1px solid var(--border, #333); border-radius: 8px;
			padding: 12px 14px; display: grid; gap: 8px; align-self: stretch;
			min-height: 320px; align-content: start;
		}
		.wmx .empty-reader { display: grid; place-content: center; height: 100%; min-height: 300px; opacity: .4; }
		.wmx .reader pre.body {
			margin: 0; white-space: pre-wrap; word-break: break-word;
			font: inherit; max-height: calc(100vh - 340px); max-height: calc(100dvh - 340px); overflow: auto;
			background: var(--bg-elev1, #16161d); border-radius: 6px; padding: 10px;
		}
		.wmx .reader .actions { display: flex; gap: 6px; flex-wrap: wrap; }

		/* modals (settings / compose) */
		.wmx .modal-backdrop {
			position: fixed; inset: 0; z-index: 1000;
			background: rgba(0, 0, 0, .5);
			display: flex; align-items: center; justify-content: center;
		}
		/* the UA style for the hidden attribute is display:none, which the
		   display:flex above would override - push it back explicitly */
		.wmx .modal-backdrop[hidden] { display: none; }
		.wmx .modal {
			width: min(600px, 94vw); max-height: 88vh;
			background: var(--bg-elev0, #101016); border: 1px solid var(--border, #333);
			border-radius: 12px; padding: 0; box-shadow: 0 18px 48px rgba(0,0,0,.45);
			display: flex; flex-direction: column; overflow: hidden;
		}
		.wmx .modal-head {
			flex-shrink: 0;
			padding: 12px 16px;
			border-bottom: 1px solid var(--border, #333);
			display: flex; align-items: center; justify-content: space-between; gap: 10px;
		}
		.wmx .modal-head b { font-size: 14px; }
		.wmx .modal-head .modal-close { flex-shrink: 0; width: 28px; height: 28px; padding: 0; line-height: 1; font-size: 13px; }
		.wmx .modal-body { overflow: auto; min-height: 0; padding: 12px 16px 16px; }
		.wmx .cfg fieldset {
			border: 1px solid var(--border, #333); border-radius: 8px;
			display: grid; grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr); gap: 6px 10px;
			padding: 8px 10px; align-items: center; margin: 8px 0 0;
		}
		.wmx .cfg fieldset legend { font-size: 11px; opacity: .6; padding: 0 6px; }
		.wmx .cfg label { font-size: 12px; opacity: .7; }
		.wmx .cfg .full { grid-column: 1 / -1; display: flex; gap: 6px; align-items: center; }
		.wmx form.compose input, .wmx form.compose textarea { width: 100%; box-sizing: border-box; }
		.wmx form.compose .row { display: flex; gap: 8px; justify-content: flex-end; }

		/* phone portrait (360-430px): one column, a larger font so iOS does not zoom
		   on focus, bigger hit targets, and a bottom sheet. Desktop is unchanged. */
		@media (max-width: 640px) {
			.wmx input, .wmx select, .wmx textarea { font-size: 16px; }
			.wmx button { min-height: 36px; }
			/* settings modal: label above input, and the empty spacers take no row */
			.wmx .cfg fieldset { grid-template-columns: 1fr; }
			.wmx .cfg fieldset label:empty, .wmx .cfg fieldset span:empty { display: none; }
			/* the modal becomes a bottom sheet, with safe-area padding underneath */
			.wmx .modal-backdrop { align-items: flex-end; }
			.wmx .modal {
				width: 100%; max-height: 92vh; max-height: 92dvh;
				border-radius: 14px 14px 0 0;
			}
			.wmx .modal-body { padding-bottom: calc(16px + env(safe-area-inset-bottom)); }
		}
	</style>

	<header class="wmx-head">
		<h2>\u{1f4ec} Webmail
			<span class="chip st">\u2026</span>
			<span class="chip unseen badge" hidden></span>
		</h2>
		<div class="head-actions">
			<button class="btn-compose" title="Compose">\u2709 Compose</button>
			<button class="btn-gear" title="Mail settings">\u2699 Settings</button>
			<button class="btn-refresh" title="Refresh the list">Refresh</button>
		</div>
	</header>
	<p class="hint deps" hidden>Runtime dependencies are missing (imapflow / mailparser / nodemailer) and are being
		installed in the background; you can also
		<button class="btn-deps">Install now</button></p>

	<div class="wmx-body">
		<section class="pane-list">
			<div class="toolbar">
				<select class="folder"><option value="INBOX">INBOX</option></select>
				<input type="search" class="q" placeholder="Search subject / sender\u2026" />
				<button class="btn-search">Search</button>
				<label style="opacity:.7;font-size:12px"><input type="checkbox" class="unseen-only" /> Unread</label>
			</div>
			<ul class="maillist"></ul>
		</section>
		<section class="reader">${EMPTY_READER}</section>
	</div>

	<div class="modal-backdrop cfg-modal" hidden>
		<div class="modal" role="dialog" aria-label="Mail settings">
			<div class="modal-head"><b>\u2699 Mail settings</b><button class="modal-close" title="Close">\u2715</button></div>
			<div class="modal-body">
			<form class="cfg">
				<fieldset>
					<legend>Incoming IMAP</legend>
					<label>Server</label><input name="imapHost" placeholder="imap.example.com" />
					<label>Port</label><input name="imapPort" type="number" placeholder="993" />
					<label>Username</label><input name="imapUser" autocomplete="off" />
					<label>Password / app password</label><input name="imapPass" type="password" autocomplete="new-password" />
					<label class="full"><input type="checkbox" name="imapTls" /> Use SSL/TLS (the port is usually 993; 143 when off)</label>
				</fieldset>
				<fieldset>
					<legend>Outgoing SMTP</legend>
					<label>Server</label><input name="smtpHost" placeholder="smtp.example.com" />
					<label>Port</label><input name="smtpPort" type="number" placeholder="465" />
					<label>Username</label><input name="smtpUser" autocomplete="off" />
					<label>Password / app password</label><input name="smtpPass" type="password" autocomplete="new-password" />
					<label>Display sender</label><input name="smtpFrom" placeholder="Me &lt;me@example.com&gt;" />
					<label class="full"><input type="checkbox" name="smtpTls" /> Use SSL/TLS (the port is usually 465)</label>
				</fieldset>
				<fieldset>
					<legend>Behaviour</legend>
					<label>Poll interval (seconds)</label><input name="pollSec" type="number" min="15" />
					<label></label><span></span>
					<label class="full"><input type="checkbox" name="notifyEnabled" /> Show a notification for new mail</label>
					<label class="full"><input type="checkbox" name="aiEnabled" />
						Let the AI manage the mailbox - registers the mail_list / mail_read / mail_search / mail_send /
						mail_manage tools for the agent in the conversation (the AI confirms with you before sending)</label>
				</fieldset>
				<fieldset>
					<legend>Plugin update</legend>
					<label class="full" style="justify-content:space-between">
						<span style="opacity:.75">Fetch the latest version from GitHub and install it over this one
							(settings are kept; dependencies are reinstalled automatically)</span>
						<button type="button" class="btn-update">Update to the latest version</button>
					</label>
					<p class="hint full">The update runs in a visible terminal; refresh the page afterwards to load the
						new version.</p>
				</fieldset>
				<p class="hint">Credentials stay on this machine and are never uploaded; they survive a plugin
					reinstall. Changes apply as soon as you save.</p>
				<div class="row" style="display:flex;justify-content:flex-end"><button type="submit" class="primary">Save and apply</button></div>
			</form>
			</div>
		</div>
	</div>

	<div class="modal-backdrop compose-modal" hidden>
		<div class="modal" role="dialog" aria-label="Compose">
			<div class="modal-head"><b>\u2709 Compose</b><button class="modal-close" title="Close">\u2715</button></div>
			<div class="modal-body">
			<form class="compose">
				<input name="to" placeholder="Recipient to@example.com" required />
				<input name="subject" placeholder="Subject" />
				<textarea name="body" rows="8" placeholder="Body\u2026"></textarea>
				<div class="row">
					<button type="button" class="btn-cancel">Cancel</button>
					<button type="submit" class="primary">Send</button>
				</div>
			</form>
			</div>
		</div>
	</div>
</div>`);

		const root = container.querySelector<HTMLElement>(".wmx")!;
		/** Every selector below belongs to the template this module just rendered,
		 *  so each one is known to exist; the cast only supplies its element type. */
		const $ = <T extends Element = HTMLElement>(sel: string): T => root.querySelector<T>(sel) as T;
		const st: { mails: MailSummary[]; activeUid: number | null } = { mails: [], activeUid: null };

		function openModal(sel: string): void {
			const modal = $<HTMLElement>(sel);
			modal.hidden = false;
			const first = modal.querySelector<HTMLElement>("input, textarea");
			if (first) first.focus();
		}
		function closeModal(sel: string): void {
			$<HTMLElement>(sel).hidden = true;
		}

		function setStateChips(state: PublicState): void {
			const chip = $<HTMLElement>(".st");
			chip.textContent = state.status || "Unknown";
			chip.className = `chip st ${state.configured ? (state.status.startsWith(STATUS_FAILED_PREFIX) ? "err" : "ok") : ""}`;
			const badge = $<HTMLElement>(".unseen");
			badge.hidden = !state.unseen;
			badge.textContent = `${state.unseen} unread`;
			$<HTMLElement>(".deps").hidden = state.depsOk || state.depsInstalling;
			const deps = $<HTMLButtonElement>(".btn-deps");
			deps.disabled = Boolean(state.depsInstalling);
			deps.textContent = state.depsInstalling ? "Installing\u2026" : "Install now";
		}

		function fillSettings(payload: PublicState | PublicConfig | undefined): void {
			// The server nests the settings inside the state payload (state.config);
			// a top-level config is only there for older servers.
			const cfg = ((payload as PublicState | undefined)?.config ?? payload) as PublicConfig | undefined;
			if (!cfg) return;
			const f = $<SettingsForm>(".cfg");
			f.imapHost.value = cfg.imap?.host ?? "";
			f.imapPort.value = String(cfg.imap?.port ?? 993);
			f.imapUser.value = cfg.imap?.user ?? "";
			f.imapPass.placeholder = cfg.imap?.hasPass ? "Saved (type to override)" : "Password";
			f.imapTls.checked = cfg.imap?.tls !== false;
			f.smtpHost.value = cfg.smtp?.host ?? "";
			f.smtpPort.value = String(cfg.smtp?.port ?? 465);
			f.smtpUser.value = cfg.smtp?.user ?? "";
			f.smtpPass.placeholder = cfg.smtp?.hasPass ? "Saved (type to override)" : "Password";
			f.smtpFrom.value = cfg.smtp?.from ?? "";
			f.smtpTls.checked = cfg.smtp?.tls !== false;
			f.pollSec.value = String(cfg.pollSec ?? 60);
			f.notifyEnabled.checked = cfg.notifyEnabled !== false;
			f.aiEnabled.checked = Boolean(cfg.aiEnabled);
		}

		function renderList(): void {
			const ul = $<HTMLElement>(".maillist");
			if (!st.mails.length) {
				setMarkup(ul, `<li class="empty" style="list-style:none;border:0;cursor:default;display:block;text-align:center;opacity:.45;padding:24px 0">No matching messages</li>`);
				return;
			}
			setMarkup(
				ul,
				st.mails
					.map(
					(m) => `
<li data-uid="${m.uid}" class="${m.seen ? "" : "unread"}${m.uid === st.activeUid ? " active" : ""}">
	<span class="from">${m.seen ? "" : '<span class="dot"></span>'}${esc(m.fromName || m.from)}</span>
	<span class="date">${esc(fmtDate(m.date))}</span>
	<span class="subj">${esc(m.subject)}</span>
</li>`,
					)
					.join(""),
			);
		}

		function renderReader(mail: ReadMail): void {
			const r = $<HTMLElement>(".reader");
			setMarkup(r, `
<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
	<b style="font-size:14px">${esc(mail.subject)}</b>
	<span style="opacity:.55;font-size:11px">${esc(fmtDate(mail.date))}</span>
</div>
<div style="opacity:.7;font-size:12px">${esc(mail.fromName)} &lt;${esc(mail.from)}&gt; \u2192 ${esc(mail.to)}
	${mail.hasAttachments ? " \u00b7 \u{1f4ce} has attachments (not shown below the body)" : ""}</div>
<pre class="body">${esc(mail.text)}${mail.truncated ? "\n\n\u2026(truncated because it is too long)" : ""}</pre>
<div class="actions">
	<button class="act-toggle-seen">${mail.seen ? "Mark as unread" : "Mark as read"}</button>
	<button class="act-reply">Reply</button>
	<button class="act-delete danger">Delete</button>
</div>`);
			$<HTMLElement>(".act-toggle-seen").onclick = () =>
				ctx.send({ action: "mark", uids: [mail.uid], seen: !mail.seen });
			$<HTMLElement>(".act-delete").onclick = () => ctx.send({ action: "delete", uids: [mail.uid] });
			$<HTMLElement>(".act-reply").onclick = () => openCompose({ to: mail.from, subject: `Re: ${mail.subject}` });
			// In the narrow single-column layout the list is above the reader, so
			// scroll the reader into view after a selection (desktop does not run this).
			if (window.matchMedia("(max-width: 640px)").matches) r.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}

		function clearReader(): void {
			st.activeUid = null;
			setMarkup($<HTMLElement>(".reader"), EMPTY_READER);
		}

		function openCompose(prefill: { to?: string; subject?: string } = {}): void {
			const f = $<ComposeForm>("form.compose");
			f.to.value = prefill.to ?? "";
			f.subject.value = prefill.subject ?? "";
			openModal(".compose-modal");
			(prefill.to ? f.body : f.to).focus();
		}

		async function refreshList(): Promise<void> {
			ctx.send({
				action: "list",
				folder: $<HTMLSelectElement>(".folder").value,
				unseenOnly: $<HTMLInputElement>(".unseen-only").checked,
			});
		}

		// ---- events ----
		root.addEventListener("click", async (e) => {
			// A click inside root always has an element target.
			const target = e.target as Element;
			const li = target.closest<HTMLElement>("ul.maillist li[data-uid]");
			if (li) {
				st.activeUid = Number(li.dataset.uid);
				renderList();
				ctx.send({ action: "read", folder: $<HTMLSelectElement>(".folder").value, uid: st.activeUid });
				return;
			}
			if (target.closest(".btn-refresh")) void refreshList();
			if (target.closest(".btn-compose")) openCompose();
			if (target.closest(".btn-gear")) {
				// Pull the state again before opening: the first echo at mount time may
				// predate the server finishing its read of the local configuration.
				ctx.send({ action: "get_state" });
				openModal(".cfg-modal");
			}
			if (target.closest(".btn-update")) {
				// Reuse the host application's visible terminal to run the update (the
				// same path a source-control commit or pull takes).
				window.dispatchEvent(
					new CustomEvent("pi-web-ui:plugin-run-command", {
						detail: {
							title: "webmail update",
							command: "pi-web-ui install xing-shuyin/pi-web-ui/tree/main/plugins/webmail --force",
						},
					}),
				);
				closeModal(".cfg-modal");
			}
			if (target.closest(".btn-deps")) ctx.send({ action: "install_deps" });
			if (target.closest(".btn-search")) {
				const q = $<HTMLInputElement>(".q").value.trim();
				if (q) ctx.send({ action: "search", query: q, folder: $<HTMLSelectElement>(".folder").value });
				else void refreshList();
			}
			// Modals: close on a backdrop click or on the close button.
			for (const sel of [".cfg-modal", ".compose-modal"]) {
				const backdrop = $<HTMLElement>(sel);
				if (target === backdrop || target.closest(".modal-close")) closeModal(sel);
			}
		});
		root.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				closeModal(".compose-modal");
				closeModal(".cfg-modal");
			}
			if (e.key === "Enter" && (e.target as Element).classList.contains("q"))
				$<HTMLButtonElement>(".btn-search").click();
		});
		$<HTMLInputElement>(".unseen-only").addEventListener("change", () => void refreshList());

		$<SettingsForm>(".cfg").addEventListener("submit", (e) => {
			e.preventDefault();
			const f = e.target as SettingsForm;
			const cfg: {
				imap: Record<string, unknown>;
				smtp: Record<string, unknown>;
				pollSec: number;
				notifyEnabled: boolean;
				aiEnabled: boolean;
			} = {
				imap: {
					host: f.imapHost.value.trim(),
					port: Number(f.imapPort.value) || 993,
					tls: f.imapTls.checked,
					user: f.imapUser.value.trim(),
					// Blank means "keep the stored password".
					pass: f.imapPass.value || undefined,
				},
				smtp: {
					host: f.smtpHost.value.trim(),
					port: Number(f.smtpPort.value) || 465,
					tls: f.smtpTls.checked,
					user: f.smtpUser.value.trim(),
					pass: f.smtpPass.value || undefined,
					from: f.smtpFrom.value.trim(),
				},
				pollSec: Math.max(15, Number(f.pollSec.value) || 60),
				notifyEnabled: f.notifyEnabled.checked,
				aiEnabled: f.aiEnabled.checked,
			};
			// Drop the undefined entries so the server's merge semantics apply (an
			// empty password field keeps the value already stored).
			for (const box of ["imap", "smtp"] as const) {
				const section = cfg[box];
				for (const key of Object.keys(section)) {
					if (section[key] === undefined) delete section[key];
				}
			}
			ctx.send({ action: "save_config", config: cfg });
			closeModal(".cfg-modal");
		});

		$<ComposeForm>("form.compose").addEventListener("submit", (e) => {
			e.preventDefault();
			const f = e.target as ComposeForm;
			ctx.send({
				action: "send",
				to: f.to.value.trim(),
				subject: f.subject.value,
				body: f.body.value,
			});
			f.reset();
			closeModal(".compose-modal");
		});
		$<HTMLElement>("form.compose .btn-cancel").addEventListener("click", () => {
			$<ComposeForm>("form.compose").reset();
			closeModal(".compose-modal");
		});

		// ---- server -> view ----
		const off = ctx.onData((payload) => {
			const msg = (payload ?? {}) as ServerMessage;
			switch (msg.kind) {
				case "state":
					setStateChips(msg.state!);
					fillSettings(msg.state ?? msg.config);
					break;
				case "mails":
					st.mails = msg.mails ?? [];
					renderList();
					break;
				case "mail":
					renderReader(msg.mail!);
					break;
				case "new-mail":
					void refreshList();
					break;
				case "result":
					if (msg.action === "mark") renderList();
					if (msg.action === "delete") {
						clearReader();
						void refreshList();
					}
					break;
			}
		});

		ctx.send({ action: "get_state" });
		void refreshList();

		return () => {
			off();
			root.remove();
		};
	},
};
