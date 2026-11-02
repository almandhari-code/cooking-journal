# Round 3 brief (vanilla JS PWA; files: index.html, app.js, js/*, styles.css, sw.js, tests/)
Server already running at http://localhost:8777. Branch dev. Do NOT push.
A) Long sessions
- Pause/resume recording within one session; "Add to this dish" mid-cook (append to current session/dish).
- Chunk audio (~10 min chunks, each < 25MB Groq limit), transcribe each with Groq Whisper, merge transcripts in order.
- Pass Whisper `prompt` with Omani food vocab: machboos, bzar, shuwa, harees, mashuai, laban, qahwa, halwa, kahwa, maqboos, saloona, mashkak, khubz, dates, cardamom, saffron, loomi.
- LLM extraction prompt: ignore chatter/nonsense/silence, keep only cooking info; normalize Omani spellings (makbous->machboos, bazaar->bzar).
B) Design: cute cartoon game style, pink & cream palette, rounded, playful, mobile-first.
- XP + levels, streaks, badges, per-dish progress chart (rating across versions, inline SVG/canvas, no CDN needed), fun sounds (WebAudio) + animations, mute toggle saved in settings.
Verify: run existing tests + add tests (mock Groq). Take screenshots with Playwright at mobile size (390x844) of home, recording, dish/progress; save as screenshots/*.png and check them yourself. Max 2 screenshot-fix rounds.
Commit on dev. Finally write SUMMARY.md: what changed, commit hash, screenshot paths, open issues (short).
