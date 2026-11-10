# Boardroom Live — handoff

An AI advisory board as a live video call. You join a meeting with three AI advisors who appear in video tiles, talk to them by voice, and they answer out loud, disagree with each other, and produce structured minutes at the end.

This folder is everything built so far as a prototype inside a claude.ai artifact (a sandboxed web page). This document explains what exists, how it works, which parts depend on the claude.ai sandbox, and what to build next.

---

## 1. The product idea

- **Video-call grid.** Your tile plus one tile per advisor, with an active-speaker glow, audio meters and live captions.
- **Voice first.** You speak; when you pause, the system decides who answers. Advisors reply out loud with lip movement.
- **Interruptions.** Speaking (or tapping the mic) while an advisor talks stops them and the board listens.
- **The panel.**
  - **Elena — Growth & Marketing:** audience psychology, positioning, brand narrative, messaging, acquisition, retention. Energetic, ambitious.
  - **Marcus — Technology & Architecture:** architecture, feasibility, latency, privacy/GDPR, tech debt, build vs buy. Dry, precise, sceptical of over-engineering.
  - **Devon — Operations & Logistics:** execution, unit economics, timelines, bottlenecks, suppliers, UK compliance. Pragmatic, brings numbers, brokers compromises. (Devon is a woman in the current designs.)
- **The point of the product is the debate.** Advisors push back on the founder and on each other instead of agreeing. Direct address ("Marcus, …") or tapping a tile routes the question; open questions go to whoever's domain is hit hardest, and others join only to add a trade-off, disagreement or compromise.
- **Minutes.** Ending the call generates a summary, decisions, action points (owner, due, priority), a 3×3 risk matrix (likelihood × impact) and open questions, exportable as Markdown.

---

## 2. Folder layout

```
app/                          the web app (static files)
  index.html                  everything: UI, orchestration, lip-sync, minutes (~1,000 lines, inline CSS + JS module)
  kokoro-worker.mjs           Web Worker: in-browser neural TTS (Kokoro-82M via onnxruntime-web)
  kokoro/
    vocab.json                Kokoro phoneme → token ids
    voices/*.wasm             voice style vectors (raw float32, 510×256). .wasm extension only because the artifact host
                              serves a fixed list of file types; rename freely once self-hosted
    ort/ort-wasm-simd-threaded.wasm   onnxruntime-web 1.22.0 runtime
    model.part0-6.wasm        NOT INCLUDED (92 MB) — run tools/fetch_kokoro.sh
  video/<name>-still.jpg      each advisor's resting frame (854×480), taken from their video at 0.08 s
  visemes/<name>.jpg          mouth-shape atlas per advisor: 8 patches of 128×88 px side by side
assets/
  character-sheets/           full-body designs (front/side/back) generated from the prompts in §8
  source-videos/              the three 10 s Gemini talking-head clips the stills and mouth shapes come from
tools/
  build_visemes.py            rebuilds visemes/<name>.jpg from the source videos (OpenCV)
  visemes-meta.json           patch box / frames chosen by the last build
  fetch_kokoro.sh             downloads the Kokoro model and splits it into the 7 parts
```

Run locally: `bash tools/fetch_kokoro.sh`, then serve `app/` with any static server (`npx serve app` or `python3 -m http.server -d app`). It must be served over http(s), not opened as a file, because it uses module workers and fetch.

---

## 3. How it works

### 3.1 Turn flow (in `index.html`)
1. **Join screen.** Topic textarea with example topics, roster with per-advisor voice picker, natural-voice download button, Join.
2. **On join** the board opens the meeting (Devon welcomes and restates the topic, Elena asks a framing question).
3. **You speak or type.** Speech ends after ~1.5 s of silence (simple VAD on dictation partials/finals), or tap the mic again to send. Typed input always works.
4. **`runTurn()`** sends the system prompt plus the last ~28 history turns to the model and **streams** the reply. The model must answer in lines like `MARCUS: …`. Each completed line is parsed by `LINE_RE` and handed to speech immediately, so the first advisor starts talking before the whole answer exists.
5. **Speech queue.** Lines play in order; each line start sets the active speaker (glow, captions, other advisors' attention) and starts lip-sync.
6. **Interrupt** (`interrupt()`): aborts the stream, cancels queued speech, records "(The founder interrupts.)" in history.
7. **End call** → second model call returns JSON minutes → rendered panel → Markdown download/copy.

System prompt rules (see `systemPrompt()`): 1–4 turns per reply, 1–3 spoken sentences each, max 55 words, plain speech (no lists/markdown/emoji), named advisor answers first, others only for genuine trade-offs, estimates in GBP, last speaker ends with a sharp question when the decision is the founder's. Model tier "quick" for turns (latency), "default" for minutes.

### 3.2 Speech output — four modes, best available wins
`S.speechMode` is one of:
| mode | what | lip-sync clock |
|---|---|---|
| `kokoro` | Kokoro-82M neural TTS in a Web Worker, British voices (Emma, Isabella, Alice, Lily / George, Lewis, Daniel, Fable). Apache-2.0. One-time 100 MB download, cached in IndexedDB. Page runs a speed test; if slower than 1.15× real time it falls back. | **Exact**: from the generated audio (AudioContext clock + amplitude envelope) |
| `tts` | claude.ai sandbox voices (`buttery`, `airy`, `glassy`, `rounded`) | `onPosition` progress events + learned speaking pace |
| `synth` | browser `speechSynthesis`, ranked to prefer neural/premium/enhanced voices, gender-matched by voice name | estimated from text; re-synced on word-boundary events; pace learned per voice from real durations |
| `text` | captions only, timed by word count | estimated |

Kokoro specifics (`kokoro-worker.mjs`): text normalisation and phonemisation ported from kokoro-js (Apache-2.0), espeak-ng British English via the `phonemizer` package, tokens padded with 0 at both ends, style vector row = `min(tokens,510)-1`, 24 kHz output. Turns are split into sentences and synthesised ahead while earlier sentences play. Measured speed: ~1.4 s of compute per 1 s of audio on a slow single server core, so expect roughly real time on a recent laptop, slower on phones.

### 3.3 Faces and lip-sync
- Each tile draws the advisor's **still frame** on a canvas with breathing/sway transforms and procedural blinks (eyelid colour sampled from the photo; eye positions are hand-measured in `PHOTOS`).
- **Mouth atlas:** `tools/build_visemes.py` tracks the face (template match on the eyes/nose band, with scale search) through the source video, aligns frames to the still, and extracts real mouth patches: closed, 5 openness levels (neutral lip width, so not smiles), rounded lips, teeth showing.
- **At runtime** (`mouthAt()` + `drawPhoto()`): the mouth openness value picks and cross-fades between ladder patches, with the rounded or teeth patch blended in for O/U/R or F/S/TH sounds. Patches are feathered with a radial alpha mask, so the joins don't show (verified on all three).
  - With **Kokoro**, openness = loudness of the actual audio (10 ms envelope) and shape = phoneme timeline from Kokoro's own phonemes. This is the accurate path.
  - Otherwise, openness and shape come from a phoneme timeline (`LipsyncEn` from `@met4citizen/talkinghead`) stretched over the estimated line duration.
- **Known limitation:** only the mouth moves while speaking; the head is a still frame (plus sway). The full-motion videos were tried as "talking" loops but the mouth then didn't match the words, so they're now only the source for mouth shapes.

### 3.4 Your tile
- Live camera isn't possible in the sandbox. You can add a photo (downscaled to 640 px, saved in `localStorage`), shown with subtle motion. The glow lights up while you're dictating.

---

## 4. What depends on the claude.ai sandbox — must be replaced when self-hosting

The page calls `window.claude.use(name)` capabilities that only exist inside claude.ai artifacts:

| capability | used for | replacement when self-hosted |
|---|---|---|
| `sample` | all LLM calls: board turns (streaming, `onText`) and minutes (`sample.json`) | Claude API (Messages API with streaming) behind your own backend; never put the API key in the browser |
| `tts` | claude.ai voices | ElevenLabs streaming TTS (or keep Kokoro) |
| `dictation` | speech-to-text, Chromium/desktop app only | `getUserMedia` + a streaming STT (Deepgram, AssemblyAI, ElevenLabs Scribe, or Whisper), with real VAD (e.g. Silero VAD) and barge-in |
| `downloads` | saving minutes .md | a normal `<a download>` link |

Other sandbox constraints that shaped the prototype and disappear when self-hosted:
- No camera or microphone access.
- No requests to outside hosts (no ElevenLabs/HeyGen/APIs).
- Scripts only from approved CDNs.
- A fixed list of servable file types, hence `.wasm` names for binary model parts.
- 15 MB per file, hence the split model.

All calls are wrapped so the page still renders when a capability is `null` (scripted demo when `sample` is missing, captions when no voice).

---

## 5. Recommended next steps (production path)

1. **Host it yourself.** Akshay's own domain plus a small backend (e.g. a Cloudflare Worker or Node server) that holds the keys and proxies:
   - Claude API (streaming) for turns and minutes. Keep the line-based output format and `LINE_RE` streaming parser.
   - ElevenLabs streaming TTS with three cloned or designed voices that match the Gemini videos. Use the word/character timestamps it returns to drive the existing `mouthAt()` exactly, the same way the Kokoro path uses its audio.
2. **Real mic and camera.** `getUserMedia`, streaming STT, VAD-based end of turn, and true barge-in (pause TTS when the user starts speaking).
3. **Better faces (pick one).**
   - Keep the atlas approach, but add more mouth patches and a "listening" idle clip per advisor (prompt in §8).
   - Or move to a real-time neural avatar service (Simli, HeyGen Interactive, Tavus) for full-motion, phoneme-accurate video. This costs per minute.
   - Or build matching 3D avatars (Avaturn from the face photos) and drive them with TalkingHead, which is already compatible with the viseme timeline code.
4. **Persistence.** Save meetings, transcripts and minutes per user. Let advisors remember earlier meetings.
5. **Latency budget.** Target under 1.5 s from end of speech to first audio: stream everything, synthesise sentence by sentence, start TTS on the first complete line.

---

## 6. Licences of bundled pieces
- **Kokoro-82M model and voices:** Apache-2.0. Commercial use OK.
- **kokoro-onnx** (model export, release files): MIT.
- **kokoro-js** (ported normalisation/phonemise code): Apache-2.0.
- **phonemizer** (espeak-ng build, loaded from jsDelivr): Apache-2.0.
- **onnxruntime-web 1.22.0:** MIT.
- **@met4citizen/talkinghead lipsync-en** (loaded from jsDelivr): MIT.
- **Character sheets and videos:** generated by Akshay with Gemini. Check Google's terms before commercial use.

---

## 7. Open issues / ideas not yet done
- Lip-sync with `tts`/`synth` voices is estimated and can drift. Kokoro (exact) is the reference behaviour.
- Mouth shapes for Elena's lowest two openness levels are the same frame. Rebuilding with more source footage would give finer steps.
- No listening animation beyond blink, breathing and sway. Generate idle clips (§8).
- Advisor "looks at the speaker" only worked with the earlier 3D avatars. Photos can't turn.
- Voice picker previews need a user tap first (browser audio rules).
- No automated tests yet. The key pure functions to test are `LINE_RE` parsing, `splitSentences`, `ipaToKeys`, `mouthAt`, `normalise`/`toPhonemes` (worker), and minutes rendering with partial JSON.

---

## 8. Prompts used for the characters

**Full-body character sheet (Elena; same structure for Marcus and Devon):**
> Full-body character design sheet of Elena, a 32-year-old British woman, growth and marketing lead at a modern startup. Photorealistic, natural skin texture, warm confident expression, slight smile, expressive eyebrows. Shoulder-length wavy auburn hair with soft layers, light makeup, small gold hoop earrings. Outfit: tailored terracotta blazer with sleeves pushed up, cream silk blouse, high-waisted charcoal trousers, white leather trainers, slim smartwatch. Energetic, approachable posture. Three views side by side: front, side profile, back. Neutral A-pose, arms slightly away from body, feet shoulder-width apart, full body from head to toe visible. Plain light-grey studio background, soft even lighting, 85mm lens, high detail, consistent proportions across views.

- **Marcus:** 38-year-old Black British software architect, short fade, trimmed beard, thin black rectangular glasses, navy merino crew-neck over light-blue shirt, dark chinos, black trainers, steel watch.
- **Devon:** 41-year-old British woman, head of operations, dark brown low ponytail, olive utility overshirt over white T-shirt, dark jeans, brown ankle boots, rugged watch.

**Listening clip (still to generate, one per advisor):**
> Same woman as before [description + outfit], same background, same framing and camera. 10 seconds. She is silently listening to someone on a video call: mouth closed the whole time, small natural nods, occasional blinks, slight thoughtful smile, tiny head tilts, hands still. No talking, no lip movement. Static camera.

---

## 9. Live prototype
Published as a private claude.ai artifact, "Boardroom Live" (version 10 at handoff). It can only be opened by Akshay unless shared.

---

## 10. Progress since handoff (self-hosting, step 1 of §5)

- **Backend added:** `server/server.mjs` (Node 20+, Anthropic SDK). Serves `app/`, holds the API key, and proxies Claude:
  `POST /api/turn` streams board turns as NDJSON; `POST /api/minutes` returns minutes constrained to a JSON schema.
  Model `claude-opus-5-5`, low effort for turns (latency), medium for minutes, server-side refusal fallbacks on both.
- **Sandbox capabilities replaced** by `app/claude-shim.js`: `sample` → the backend, `dictation` → browser SpeechRecognition,
  `downloads` → `<a download>`. `index.html` is unchanged apart from loading the shim and two "open in claude.ai" messages,
  so it still runs as a claude.ai artifact.
- **Offline demo mode:** `BOARD_FAKE=1` streams canned replies through the real pipeline (no API calls), for demos and tests.
- **Tests:** `cd server && npm test` (20 tests: request validation, path traversal, streaming, error codes, the exact Claude
  request, the shim's streaming/dictation behaviour, and `LINE_RE`). A full meeting (join → ask → three advisors speak →
  minutes) was also run in headless Chromium against the demo server.
- **Still to do from §5:** ElevenLabs streaming TTS with timestamps, `getUserMedia` + streaming STT with VAD and barge-in
  (SpeechRecognition is Chrome/Edge/Safari only and has no true barge-in), auth and rate limiting before any public URL,
  persistence, and self-hosting the two jsDelivr imports (lip-sync timeline and onnxruntime-web).
