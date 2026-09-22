# Session Shadow

Session Shadow adds a compact read-only observer to the existing right panel. Select **Session Shadow** beside Files to see the host-active agent session's recent user, answer, and tool activity without exposing controls that can prompt or steer the agent.

A small **Window chat** is stored by the plugin server and scoped to the observed session. It is shared across connected browsers and survives page refreshes and service restarts. Open **Settings → Session Shadow** in each browser to save the name and email attached to that browser's messages; identity stays in that browser's local storage.

## Limits

- The plugin host exposes the globally most recently active conversation, not each browser's independently selected conversation. The panel therefore follows that host-active session.
- Up to 10 recently observed sessions, 20 activity rows per session, and 50 window-chat messages per session are retained in the live view.
- Thinking content is never mirrored; the feed only shows a `Thinking` status row.
- This is an observer and human side channel. Interacting with the agent still requires the owning browser or the host's **Take over** action.

## Install

```sh
pi-web-ui install Jensen95/pi-web-ui-plugins/plugins/session-shadow --build
```

Requires a pi-web-ui version with `rightpanel.tabs`, `host.getActiveConversation()`, and run-event plugin hooks.
