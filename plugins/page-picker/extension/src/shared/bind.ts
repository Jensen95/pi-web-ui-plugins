/// <reference lib="dom" />

import { normalizeServerUrl } from "./settings.js";

export interface PiProbe {
	isPiWebUi: boolean;

	hasHost?: boolean;

	piVersion?: string;

	url: string;
	title?: string;
}

export interface BindView {
	base: string;

	bound: string;

	same: boolean;
	title: string;
	detail: string;

	bindLabel?: string;
}

export function bindView(pageUrl: string, boundUrl: string): BindView {
	const base = normalizeServerUrl(pageUrl);
	const bound = normalizeServerUrl(boundUrl);
	if (base === bound) {
		return {
			base,
			bound,
			same: true,
			title: "This page is the bound pi-web-ui service",
			detail: `${base} -- picks from other pages will be sent here. Pick elements on this page?`,
		};
	}
	return {
		base,
		bound,
		same: false,
		title: "This page is pi-web-ui",
		detail: `Change the picker service from ${bound} to ${base}? Future picks will be sent to this page.`,
		bindLabel: "Use as service URL",
	};
}

export interface BindResult {
	ok: boolean;
	base: string;
	message: string;

	needAuth?: boolean;
}
