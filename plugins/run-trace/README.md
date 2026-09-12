# Run Trace (`run-trace`)

A harness-style agent execution trace view that shows and analyzes the timeline for the **currently open conversation**. The horizontal swimlane timeline gives the overview; select a segment for **analysis** (source, status, duration, and share) instead of merely rereading the conversation.

## Interface

```
🧭 Run Trace ● Live    [Write a novel ● current] [Fix a bug]    Search [____]  ▶ Replay  EN  🗑
────────────────────────────────────────────────────────────────────────────────────
09:01                                        12m elapsed               09:13
Input  ▓▓────▓▓────────────────────────────────────────────────────────────────────
Model  ──▓▓▓▓▓▓▓▓▓▓▓▓▓────────────────────────────────────────────────────────────
Tools  ──────▓▓▓▓▓▓────────────────────────────────────────────────────────────────
──────────────────────────────────────┬─────────────────────────────────────────────
Segments                              │ Details (Overview / Preview / Raw / Source)
🧭 User · turn 1 · Write a novel      │ Source   Tool · edit
💭 Thinking                            │ Status   Completed
✅ edit · novel.md · 1.2s             │ Duration 1.2s
📝 1 file changed                     │ Turn     1
🏁 …                                  │ 📈 edit: 3 calls · 1.1s average ·
                                      │    0% failures · 62% of tool time
```

- **Top swimlanes:** The offline-first vis-timeline engine (bundled vendor) provides adaptive millisecond ticks, wheel zoom, drag panning, and one-click fit. Tool segments are colored by tool name (read cyan, write amber, bash purple, all others by hash); failures are red, running segments pulse, and selecting a block chooses its segment. If the vendor is unavailable, it falls back to the CDN, then to the built-in timeline.
- **Live flow (follow mode):** While a conversation runs, the timeline anchors to “now.” **Blocks move smoothly left frame by frame while tick lines stay fixed on screen** (their labels advance with time). A fixed “now” line sits 40px from the right edge; new events appear there and flow left. A running block’s right edge remains pinned to that line as it grows. Wheel zoom retains follow mode and reanchors at the new zoom; dragging pauses following, and the Follow button resumes it. When the run ends, follow mode exits smoothly without a content jump.
- **Left column:** Segment list with user, thinking, response, tool, file, and system chips, plus timestamps and durations.
- **Right column:** Four tabs for the selected segment:
  - **Overview:** Source, status, duration, turn, size, location, and analysis. Tool segments include total calls, average duration, failure rate, and share of tool time.
  - **Preview / Raw / Source:** Content and provenance: message key, call ID, turn, and conversation.
- **Without a selection:** Conversation-level analysis: total duration, turns, tool calls and failures, tool time, slowest tools, file changes, and phase distribution.
- **Replay:** Plays in **real time**. Each block remains visible for its actual duration, so brief tools flash by while long thinking pauses for longer. The playhead advances along the timeline and follows the window automatically. Controls support 0.5/1/2/4× speed, skipping idle gaps between turns, seeking, and play/pause.
- **English and Chinese UI**, plus swimlane and search filters.

## How it works

- Full history: `host.getActiveConversation()` retrieves all messages and statistics from the open conversation, so opening a conversation immediately shows its complete timeline and switching back to a previous conversation restores it.
- Live updates: `host.onRunEvent` appends or updates tool segments directly for `tool_start` and `tool_end`, including exact duration, arguments, and results. `message` and `run_*` events trigger a debounced 300ms history refresh, plus 5s streaming and 30s idle polling.
- Timing: An assistant timestamp is the message creation time (the generation start, immediately after the preceding `toolResult` in the transcript). Thinking and responses are placed backward from that timestamp using an estimated 50 characters per second, capped by the next message timestamp; durations exceeding that window are proportionally compressed and end at the tool-call start. A tool segment duration is result time minus call start, containing execution only. Instant or very short events receive a display-only minimum of about 2px, converted from the current zoom window so they remain visible and selectable; block widths align strictly with timeline ticks and converge to true duration on zoom instead of stacking serial tool calls at a fixed fake width.
- The initial overview focuses on active spans by removing long gaps between turns so actual work fills the viewport. Widely separated turns fall back to the complete range; the Fit button always shows all content.
- Smooth following combines two stages: a CSS transform moves the view frame by frame, then `setWindow` commits after at least 90px of accumulated movement. The commit synchronously redraws the vis table and resets the transform in the same frame, avoiding a visible jump. While following, the plugin hides vis’s built-in axis and grid and renders its own fixed-position ruler, advancing labels each second with an adaptive interval from 1 second to 1 day.
- File segments: Successful write-style tools (`edit`, `write`, `patch`, and others) extract paths from **call arguments**. Historical `toolCall` arguments are included too.
- Original message content is not sent by default because a single message can reach 200K. The list receives summaries only; details are loaded for the selected segment on demand.
- Timeline vendor: `npm run build:runtrace-vendor` repacks the vendor after a vis-timeline upgrade; the output is committed to git.

## Limitations

- Only the **pi engine** is currently supported; the dsh engine has no snapshots or events, so the view is empty.
- After a restart, only the most recently opened conversation remains. The transcript is the source of truth, and switching back rebuilds the trace; the plugin stores no separate copy.
