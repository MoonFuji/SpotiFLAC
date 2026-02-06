# Quality Upgrade Log Analysis

## File 1: `L_algerino - Le prince de la ville (Dj Aliloo Remi - 128K MP3.mp3`

### What happened
- **Filename parsing**: Parser treated the first part as title and the second as artist (pattern `Title - Artist`). So we got:
  - **title** = `L_algerino` (actually the **artist**)
  - **artist** = `Le prince de la ville (Dj Aliloo Remi - 128K MP3` (actually the **title** + junk)
- So **title and artist are swapped** compared to the real track: "Le prince de la ville" by **L'Algérino**.

### Search variants (wrong because of swap)
1. `Le prince de la ville (Dj Aliloo Remi - 128K MP3 L_algerino` (artist + title, with junk)
2. `L_algerino` (title-only — but that's the artist name)
3. `L_algerino Le prince de la ville (Dj Aliloo Remi - 128K MP3` (title + artist)

### Why the correct track got score -20
- **Variant 1 & 3**: Spotify correctly returns **"Le prince de la ville" - "L'Algérino"** as result #0.
- We compare:
  - metadata **title** `l_algerino` vs result **name** `le prince de la ville` → no match
  - metadata **artist** `le prince de la ville (dj aliloo remi - 128k mp3` vs result **artists** `l'algérino` → no match
- So we get **0** from title and artist. Then **duration**: file ~128s, Spotify track likely different → diff > 10s → **-20**. So total **-20**.

### Root cause
Filename was in **Artist - Title (Remix)** form, but we parsed it as **Title - Artist**, so we never compare the right fields. We need to **also try swapped title/artist** when scoring (treat metadata title as artist and metadata artist as title) so we still match when the parser got the order wrong.

---

## File 2: `Thunder.mp3`

### What happened
- **Metadata**: title=`Thunder`, artist=`Unknown Artist` (from filename), duration=**14 seconds** (likely a short clip).
- **Search**: single variant `Thunder`.

### Scores
- "Thunder" - "Imagine Dragons" → **80**
- "THUNDER (Ultra Slowed)" - "RVKN" → **115** ← **we picked this (wrong)**

### Why the wrong track won
- **Imagine Dragons**: Exact title no; word match "thunder" → 60; substring → 30; artist "Unknown Artist" vs "Imagine Dragons" → 0; duration (file 14s, track ~3min) diff > 10s → **-20**. So ~70–80.
- **RVKN (Ultra Slowed)**: Word match "thunder" → 60; substring "thunder" in "thunder (ultra slowed)" → 30; **fuzzy** "thunder" vs "thunder (ultra slowed)" → high similarity → +30 or +45; duration might be closer for a short clip → +20. So **115** is plausible.

So we **over-reward**:
1. **Fuzzy title** when the result title is "metadata title + extra (Slowed/Remix/etc)" — we should prefer **exact title** when it exists.
2. **Duration** when the file is very short (14s) and artist is unknown — we shouldn’t let duration pick a random "Thunder" variant.

### Root cause
When multiple results have the same core title ("Thunder"), we should prefer the one with **exact title match** over one with extra parentheticals (e.g. "(Ultra Slowed)"). And/or we should not give full fuzzy bonus when the result title is strictly longer than metadata and adds things like "(Slowed)", "(Remix)" that aren’t in the file’s title.

---

## Summary

| Issue | Fix |
|-------|-----|
| **Swapped title/artist** (L_algerino) | When scoring, also compute score with metadata title ↔ result artists and metadata artist ↔ result name; use **max(primary, swapped)** so we match when filename was "Artist - Title" but parsed as "Title - Artist". |
| **Wrong "Thunder"** (slowed remix chosen) | Prefer **exact title match** over fuzzy when both are above threshold; or give a bonus for exact title and/or penalize result titles that add "(Slowed)", "(Remix)" etc. when metadata doesn’t. |
