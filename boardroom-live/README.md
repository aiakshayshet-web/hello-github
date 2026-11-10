# Boardroom Live

AI advisory board as a live video call (Elena · Marcus · Devon).

Start with **HANDOFF.md** for the design and architecture. This README covers running it yourself.

## Run it self-hosted

Needs Node 20 or newer.

```bash
cd server
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start      # http://localhost:8080
```

Open http://localhost:8080 in Chrome or Edge (needed for the built-in microphone) and join.

- **No key yet?** `npm run demo` runs the whole meeting, minutes included, with canned replies and no API calls.
  Plain `npm start` without credentials serves the page's scripted demo.
- **Natural voices (optional):** `bash tools/fetch_kokoro.sh` downloads the 92 MB Kokoro model into `app/kokoro/`.
  Without it the page uses the browser's own voices.
- **Settings:** `PORT` (default 8080), `BOARD_MODEL` (default `claude-opus-5-5`).
  Credentials are anything the Anthropic SDK accepts: `ANTHROPIC_API_KEY`, or a profile from `ant auth login`.
- **Tests:** `cd server && npm test`.

## How the self-hosted version fits together

The page (`app/index.html`) was written for a claude.ai artifact, where it calls `window.claude.use(...)` for the model,
voice, microphone and downloads. `app/claude-shim.js` provides those calls outside claude.ai, so the same page runs in both
places. Inside claude.ai the real `window.claude` exists and the shim does nothing.

| artifact capability | self-hosted replacement |
|---|---|
| `sample` (board turns, streamed) | `POST /api/turn` on `server/server.mjs` → Claude Messages API, streamed back as NDJSON |
| `sample.json` (minutes) | `POST /api/minutes` → Claude with a JSON schema, so the minutes always parse |
| `dictation` | the browser's SpeechRecognition (Chrome, Edge, Safari), British English |
| `downloads` | a normal download link |
| `tts` | not provided; the page uses Kokoro or the browser's voices |

The API key stays on the server. Board turns run at low effort for speed; minutes at medium effort. Both requests opt into
server-side refusal fallbacks (`fallbacks: "default"`), so a declined request is retried on a fallback model instead of failing.

## Deploying

Any host that runs Node works (Render, Railway, Fly.io, a small VPS). Set `ANTHROPIC_API_KEY` as a secret and run
`node server/server.mjs`. Serve it over HTTPS: browsers only allow the microphone on secure pages. The server has no
login or rate limiting yet, so do not share a public URL without adding both, because anyone with the link spends your API credit.
