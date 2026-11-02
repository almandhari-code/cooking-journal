# Task C summary: "What can I cook?"

## What changed
- **Pantry page** (`#/pantry`, linked from header and home): add by typing (comma-separated ok, deduped) or by voice (existing recorder + Whisper, then LLM extracts item names). Tap ✕ to remove. Saved in localStorage (`cj_pantry`).
- **"What can I cook?"**: first saved dishes that fit (best-rated version per dish, newest on ties; up to 2 missing ingredients; water/salt assumed; fuzzy match like "red onions" ~ "onion"), sorted by fewest missing then rating. Then 4 new ideas from the Groq LLM, skipping dishes already in the journal. Every result shows missing ingredients. If the LLM call fails, saved results still show with an error note.
- Same pink-cream game style; reuses sounds, mute and the record dock/pause.
- Files: `js/pantry.js` (new), `js/groq.js` (extractPantry, suggestIdeas), `app.js`, `styles.css`, `index.html`, `sw.js` (cache v3), `tests/pantry.spec.js`.

## Tests
`npx playwright test`: 33 passed, 1 skipped (Groq mocked).

## Commit
See `git log -1` on dev (not pushed).

## Screenshots (390x844, checked by eye, 1 fix round)
- screenshots/pantry.png
- screenshots/pantry-results.png
- screenshots/pantry-recording.png

## Open issues
- Not tested with real Groq. Idea quality and voice item parsing depend on the model.
- Fit rule (max 2 missing) and staples list are fixed in code, not configurable.
- Ideas are not saved; they disappear when you leave the page.
- Full-page screenshot shows the fixed Record dock mid-page (capture artifact).
- `BRIEF-C.md` left untracked.
