/**
 * The client bundle imports the xterm stylesheet as text (esbuild's
 * {".css": "text"} loader) and injects it as a <style> element on mount, so the
 * terminal renders without the host having to serve a CSS file. TypeScript has
 * no idea what a .css import means, hence this declaration.
 */
declare module "*.css" {
	const css: string;
	export default css;
}
