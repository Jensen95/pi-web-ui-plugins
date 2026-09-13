import "./chrome.d.ts";

/** Keep the existing Chrome-shaped code working with Firefox's standard browser namespace. */
type ExtensionGlobals = {
	browser?: typeof chrome;
	chrome?: typeof chrome;
};

// SAFETY: The extension APIs are browser-provided globals; this narrows the runtime namespace for the Firefox fallback.
const globals = globalThis as unknown as ExtensionGlobals;
if (!globals.chrome && globals.browser) globals.chrome = globals.browser;
