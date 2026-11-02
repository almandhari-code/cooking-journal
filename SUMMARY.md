# Phase 2 MVP summary

## What works
- Home: dish list + big round Record button (MediaRecorder, webm/mp4).
- Groq Whisper transcription, then LLM extraction (`openai/gpt-oss-120b`, falls back to `qwen/qwen3.8-27b`), JSON mode.
- Editable review screen (name, add/remove ingredients and steps) then Save.
- IndexedDB: same dish name (case-insensitive) creates v2, v3...; original audio + transcript stored and replayable.
- "After eating" voice note: transcribe, rating 1-5 + notes, editable, saved on the version.
- Settings: Groq key in localStorage; missing key prompts to open Settings. No key in the repo.
- Clear errors for mic denied, no mic, network, 401, 429, API errors.
- PWA: manifest, icons, app-shell-only service worker.
- Playwright tests (Groq mocked, fake mic): v1 save, v2 save, rating, settings persistence, mic denied, network error, model fallback. 8/8 pass (mobile 390x844 + desktop).

## Run
- App: `python3 -m http.server 8123` then open http://localhost:8123 and enter your key in Settings.
- Tests: `npm i && npx playwright test` (screenshots in tests/screenshots, git-ignored).

## Commit
- Code: `4da83e2` on branch dev (not pushed).

## Open issues
- Not tested against the real Groq API or real Safari/iOS (mp4 path untested).
- Desktop full-page screenshots show the sticky header mid-page (capture artifact, not a UI bug).
- Needs https or localhost for mic access; API key is stored in plain localStorage.
- Only one screenshot review round was needed; no layout fixes made.
