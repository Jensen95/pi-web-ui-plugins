# Top Bar Fix (topbar-fix)

A stopgap stylesheet for [pi-web-ui#162](https://github.com/xing-shuyin/pi-web-ui/issues/162). Delete this plugin once
the fix ships upstream.

## The bug

The host renders the top-bar overflow menu (`⋯`, `.plugin-topbar-menu`) inside `.view-switch`, which carries
`overflow: hidden` so its `border-radius: 9px` clips the segmented buttons. That also clips the menu, which is
absolutely positioned and opens below the control. The menu is in the DOM, passes every validation, and can never be
seen — so a plugin entry in the `topbar.overflow` slot is unreachable, and so is anything you hide from the top bar via
Settings → Interface layout.

## The patch

```css
.view-switch {
	overflow: visible;
}
.view-switch > :first-child {
	border-radius: 8px 0 0 8px;
}
.view-switch > :last-child {
	border-radius: 0 8px 8px 0;
}
```

The corner rules put back what `overflow: hidden` was buying. `.topbar-actions` is a second, latent clipper of the same
subtree, but its `overflow-x: auto` is what keeps a narrow window usable, so it is deliberately left alone: a hidden
menu beats an unreachable top bar.

## How it runs

The host eagerly imports `client/entry.mjs` for every plugin with `hasClient && view !== false` on each client attach,
so the module patches the document at import time — before anything is opened. That is the only reason this plugin
keeps a view; the patch then hides its own tab, which has nothing to show. If the patch stops matching the host markup,
the tab reappears and explains itself.

## Install

```sh
pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/topbar-fix --build
```

## Development

```bash
npm run build:topbar-fix
npm test -- --run tests/unit/topbar-fix.test.ts
```
