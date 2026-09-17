# Voice Input (`voice-input`)

Adds a microphone action beside the composer. It uses browser speech recognition when available, then falls back to
recording a 16 kHz mono WAV for transcription by a local Whisper model or an OpenAI-compatible remote endpoint.
Recognized text is inserted into the composer as a draft and is never sent automatically.

## Settings

- `lang` — recognition and transcription language.
- `serverFallback` — enable recorded-audio fallback.
- `engine` — `auto`, `local`, or `remote`.
- `localModel` — Whisper `tiny`, `base`, or `small`.
- `transcribeUrl`, `transcribeKey`, `transcribeModel` — optional OpenAI-compatible transcription settings.

The API key is stored in plugin storage and is never returned by the plugin's settings or status routes.

## Server routes

All routes are under `/plugins-api/voice-input/`:

- `GET /settings`
- `POST /transcribe` with WAV bytes and optional `lang` query parameter
- `GET /local-status`
- `POST /local-install` with an optional `{ "model": "base" }` body
- `DELETE /local`

Local transcription installs `@xenova/transformers` on demand through the host and downloads models into the plugin's
private cache. Remote transcription posts multipart audio to `{transcribeUrl}/audio/transcriptions`.

## Setup

```sh
npm run build:voice-input
pi-web-ui install plugins/voice-input
```
