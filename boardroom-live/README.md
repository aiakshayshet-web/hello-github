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

## Roast mode

On the join screen, pick **Roast a decision** instead of **Open discussion**. The board then runs the Roast Room council
protocol (`app/roast.js`) on your decision:

1. **Brief.** The Chair turns your message into a decision with 2-4 options (always including "don't do it"), sets each
   advisor's weight 1-3, and asks up to three questions if key facts are missing.
2. **Round 1, openings.** Elena, Marcus and Devon each score every option 0-10, flag ruin risk and reversibility, and say their call out loud.
3. **Cruxes.** The Chair names what they are really fighting about. A too-quick consensus becomes a crux of its own.
4. **Round 2, debate.** Each advisor rebuts another by name, concedes their best point, and may change position.
5. **Draft resolution**, then **Round 3, the vote**: endorse, amend or dissent.
6. **Verdict.** Weighted option scores, the band (GO / GO WITH CONDITIONS / RESHAPE / DON'T DO IT), spread, confidence,
   support, and the ruin and one-way-door caps are computed in code, not by the model. The Chair writes the call, the
   reasons, the minority report, conditions, next steps, cheapest test and kill criteria.

A scoreboard under the video tiles shows the leading option as scores come in. Anything you say during the roast is
passed to the council for the next round. After the verdict the call carries on as an open discussion, and the
end-of-call minutes include the full verdict.

The advisors are the board's own fictional characters. Roast Room's real-person seats are deliberately not used.

## How the self-hosted version fits together

The page (`app/index.html`) was written for a claude.ai artifact, where it calls `window.claude.use(...)` for the model,
voice, microphone and downloads. `app/claude-shim.js` provides those calls outside claude.ai, so the same page runs in both
places. Inside claude.ai the real `window.claude` exists and the shim does nothing.

| artifact capability | self-hosted replacement |
|---|---|
| `sample` (board turns, streamed) | `POST /api/turn` on `server/server.mjs` → Claude Messages API, streamed back as NDJSON |
| `sample.json` (minutes, every Roast step) | `POST /api/json` → Claude, reply parsed as JSON (tolerates code fences) |
| `dictation` | the browser's SpeechRecognition (Chrome, Edge, Safari), British English |
| `downloads` | a normal download link |
| `tts` | not provided; the page uses Kokoro or the browser's voices |

The API key stays on the server. Board turns run at low effort for speed; minutes at medium effort. Both requests opt into
server-side refusal fallbacks (`fallbacks: "default"`), so a declined request is retried on a fallback model instead of failing.

## Deploying

Any host that runs Node works (Render, Railway, Fly.io, a small VPS). Set `ANTHROPIC_API_KEY` as a secret and run
`node server/server.mjs`. Serve it over HTTPS: browsers only allow the microphone on secure pages. The server has no
login or rate limiting yet, so do not share a public URL without adding both, because anyone with the link spends your API credit.
