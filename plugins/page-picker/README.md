# pi-web-ui Page Picker

A Chrome/Edge MV3 extension that turns selected elements from a development page into focused context for the [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) composer.

It can collect:

- a short selector, XPath, DOM path, tag summary, and dimensions;
- React or Vue source locations when development metadata is available;
- matched CSS rules, useful computed-style differences, text, and a bounded HTML skeleton;
- optional element screenshots as conversation attachments.

The extension also includes two opt-in capabilities:

- **AI page control**: lets the pi-web-ui `browser_page` bridge read, click, type, scroll, navigate, wait, evaluate JavaScript, or capture an authorized page;
- **Page bridge**: lets scripts on an explicitly paired set of pages call registered handlers across origins.

This is a browser extension, not a pi-web-ui server plugin. It is intentionally not listed in `plugins/catalog.json`.

## Install from a release

1. Download `page-picker-extension.zip` from the latest GitHub release.
2. Extract it.
3. Open `chrome://extensions` or `edge://extensions`.
4. Enable **Developer mode** and choose **Load unpacked**.
5. Select the extracted directory containing `manifest.json`.
6. Open the extension options and set the pi-web-ui service URL. Localhost is pre-authorized; remote and HTTPS origins require an explicit browser permission grant.

The extension targets the browser tab running pi-web-ui. Keep that tab open when sending a pick or when using AI page control.

## Build locally

From the repository root:

```sh
npm run build:extension
npm run pack:extension
```

`build:extension` writes the five MV3 entry points to `extension/dist/`. `pack:extension` creates `release/page-picker-extension-<version>.zip` and the stable `release/page-picker-extension.zip` alias. The packer checks the required ZIP entries before writing them.

To load a local build, choose `plugins/page-picker/extension/` in **Load unpacked** after building. Refresh the extension after rebuilding.

## Usage

- Press `Alt+Shift+P`, or click the extension icon, on a development page.
- Hover and click an element. Hold `Shift` while clicking to select multiple elements.
- Add per-element notes, choose a context preset, and click **Add to chat**.
- Configure service binding, screenshot permissions, AI page control, and page pairs in the extension options.

If the pi-web-ui page or composer is unavailable, the extension copies Markdown to the clipboard instead of silently losing the pick.

## Compatibility

The extension uses `window.__piWebUiHost.compose()` from the pi-web-ui host bridge when available. Older pi-web-ui versions receive a clear compatibility message and use the clipboard fallback. AI page control requires a pi-web-ui version exposing the corresponding page-call bridge.

## License

MIT. This extension is ported from [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui); see the repository `LICENSE` for derivative-work attribution.
