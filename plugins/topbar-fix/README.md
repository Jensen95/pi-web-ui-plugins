# Top Bar Fix (topbar-fix)

A stopgap stylesheet for two top-bar overflow-menu bugs: [pi-web-ui#162](https://github.com/xing-shuyin/pi-web-ui/issues/162)
(the menu is clipped away entirely) and a follow-up in 0.87.x (the menu is portalled, and now clips and flattens the
host controls rendered inside it). Delete this plugin once both ship upstream.

## Bug 1: the menu is clipped by `.view-switch` (#162)

The host renders the top-bar overflow menu (`⋯`, `.plugin-topbar-menu`) inside `.view-switch`, which carries
`overflow: hidden` so its `border-radius: 9px` clips the segmented buttons. That also clips the menu, which is
absolutely positioned and opens below the control. The menu is in the DOM, passes every validation, and can never be
seen — so a plugin entry in the `topbar.overflow` slot is unreachable, and so is anything you hide from the top bar via
Settings → Interface layout.

## The patch for bug 1

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

From 0.87 the host portals the menu to `document.body`, so `.view-switch` is no longer an ancestor and this rule is a
no-op there. It is kept because the plugin still supports hosts that predate the portal, and it costs nothing on newer
ones.

## Bug 2: the portalled menu clips and flattens the host controls inside it (0.87.x)

Upstream's fix for #162 renders the menu as `createPortal(<div class="plugin-topbar-menu portal">, document.body)`. A
host control switched off the top bar in Settings — Theme, Language, Sound, Update — is then re-rendered _inside_ that
menu as the real host Dropdown: `.dropdown > button.chip` plus an absolutely positioned `.dd-menu` panel. Two host
rules misfire on it.

- `.plugin-topbar-menu.portal { overflow-y: auto }` makes the portal a scroll container, and per CSS Overflow a
  computed `visible` on the other axis becomes `auto` — so it clips horizontally too. The nested `.dd-menu` is
  `right: 0; min-width: 340px` inside a `max-width: 320px` box, so it overhangs the menu's **left** edge and is sliced
  off: the section headings render as "ANGUAGE" and "HEME". A scroll container cannot scroll into inline-start
  overflow, so those pixels are unreachable, not merely scrolled away.
- `.plugin-topbar-menu button { display: block; width: 100%; border: 0 }` is an unscoped descendant selector at
  specificity (0,1,1), so it outranks both `.chip` and `.dd-item` (0,1,0). The dropdown trigger loses its
  `inline-flex` row and its border — the globe/EN/caret no longer fit their box — and every row in the opened panel
  loses `flex` and `justify-content: space-between`, which misaligns the active-item checkmark.

```css
.plugin-topbar-menu.portal:has(.dd-menu) {
	overflow: visible;
}
.plugin-topbar-menu .dropdown > button {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	width: auto;
	border: 1px solid var(--border);
	border-radius: 9px;
}
.plugin-topbar-menu .dd-item {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
}
```

The tradeoff is the `:has()` gate. There is no CSS that gives vertical scrolling _and_ horizontal escape on one box:
`overflow-y: auto; overflow-x: visible` recomputes straight back to `auto`. So the choice is per-state, not per-axis.
`.dd-menu` is in the DOM only while its dropdown is open, so a long plain overflow menu keeps scrolling at
`max-height: min(60vh, 480px)`, and only while a Theme/Language/Sound panel is open does the outer menu stop scrolling
— in that state the panel carries its own `max-height: 520px; overflow-y: auto`. Cost: switching a scroll container to
`overflow: visible` resets its scroll offset, so opening a panel from an already-scrolled menu jumps the list to the
top. On a browser without `:has()` the first rule is dropped at parse time and the clipping persists; nothing else
breaks.

Deliberately left alone:

- `overflow`/`text-overflow` on the panel rows — the ellipsis on a long theme name is wanted.
- The trigger's height. `.topbar .chip { height: var(--topbar-ctl-h, 30px) }` stops matching once the menu lives on
  `document.body`, and `--topbar-ctl-h` is declared on `.topbar`, so the chip is ~4px taller in the menu. Restoring it
  means hardcoding a host value that will rot; a slightly tall chip is not a bug worth that.
- Real plugin entries in the menu. They are direct `<button role="menuitem">` children of the portal and match none of
  these selectors.

The real fix is upstream's: scope the button rule to `.plugin-topbar-menu > button`, and do not make a container that
hosts nested absolutely positioned panels a scroll container.

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
