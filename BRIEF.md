# Cooking Journal – Phase 2 MVP brief
Build a static PWA (vanilla HTML/CSS/JS, no build step, no backend, no login) in this folder. English only, online required. Clean simple look (game styling is a later phase).

Files: index.html, app.js (ES modules ok, split into js/*.js), styles.css, manifest.webmanifest, sw.js (app-shell cache only), icons/ (192, 512 png), tests/.

Features:
1. Home: list of dishes + one big round Record button (MediaRecorder, audio/webm or mp4 on Safari).
2. Send audio to Groq Whisper: POST https://api.groq.com/openai/v1/audio/transcriptions, multipart: file, model=whisper-large-v3-turbo, language=en. Bearer key.
3. Send transcript to POST https://api.groq.com/openai/v1/chat/completions, model "openai/gpt-oss-120b" (fallback "qwen/qwen3.8-27b"), response_format {"type":"json_object"}, extract {dish, ingredients:[{name,amount,unit}], steps:[string]}. Verified working with real API.
4. Editable review screen (dish name, ingredient rows add/remove, steps), then Save.
5. IndexedDB: dishes and versions. Saving the same dish name (case-insensitive) creates v2, v3... Store original audio Blob + transcript; replay audio on the version view.
6. On a version: "After eating" voice note -> transcribe -> LLM returns {rating:1-5, notes} -> editable -> saved on that version.
7. Settings screen: Groq API key input saved to localStorage. Never hardcode or commit any key. If missing, prompt to open Settings.
8. Clear error messages (no mic permission, network/API error).

Testing: use Playwright (npx) with Chromium fake media stream flags; MOCK all Groq calls with page.route. Test: record -> review -> save v1; save again -> v2; after-eating rating; settings key persisted. Take screenshots (tests/screenshots/, mobile 390x844 + desktop), look at them, fix issues. Max 2 screenshot-fix rounds.
Do NOT push, do not add remotes, do not deploy. Commit to branch dev.
Add .gitignore (node_modules, test-results, tests/screenshots).

FINAL: write SUMMARY.md (short bullets: what works, how to run, commit hash, open issues) and commit it, then make that the last action.
