# 🥁 Rhythm Trainer

A web game for drummers that trains your internal clock. Pick a well-known
steady-tempo song (YouTube), tap along on the beat — Spacebar or click/tap —
and get scored in real time on whether you're **early, late, perfect**, how
consistent you are, and whether you tend to **rush or drag**.

No build step, no framework, no accounts. Vanilla ES modules; deployable on
any static host (GitHub Pages works as-is).

## Run it

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

(Any static server works; opening index.html via file:// won't, because of
ES-module and YouTube IFrame API restrictions.)

## How it works

- The song plays in an embedded YouTube player. `getCurrentTime()` only
  updates in ~250ms chunks, so the app polls for *change edges* and
  least-squares fits a video-time ↔ `performance.now()` mapping, giving
  millisecond-accurate conversion of tap timestamps into video time.
- Your first 8 taps lock an invisible beat grid (circular-mean phase
  estimation — only the phase is unknown; the BPM is known per song).
- Every subsequent tap is scored: Perfect ≤±40ms · Good ≤±90ms ·
  Okay ≤±135ms · Miss. A slow drift correction keeps the grid glued to the
  real recording tempo; a regression over your raw deltas detects
  rushing/dragging.
- **Input offset**: keyboards, Bluetooth audio, and human reflexes add a
  systematic lag. Settings has a calibration mini-game (Web Audio metronome,
  24 clicks) that measures your personal offset and subtracts it from every
  tap.

## 👁 Flying Blind

Optional per-session mode that periodically **mutes the song** (the video
keeps playing) and checks whether you can hold the tempo with no audio:

- **Intervals** — 4 bars of music, 2 bars blind, repeat.
- **Hard** — 4 bars on, 4 bars blind.
- **Survival** — blind windows keep growing (2→4→8→16 bars); one Miss while
  blind ends the run. Headline stat: total blind beats survived.

While blind, all timing feedback and the beat pulse are hidden (taps show
only a neutral blip) and the grid's drift correction is frozen so your drift
is *measured*, not absorbed. When the sound comes back you get a reveal:
"8 blind taps · avg drift +22ms · re-entered +38ms late". Blind taps score
×1.5 points.

## Songs

12 seeded songs (hip-hop / K-pop / pop / classics) with steady tempos, plus
an **Add custom song** form (any YouTube URL + BPM).

> ⚠️ Seed video IDs were written from memory and can rot or be
> embed-blocked. If a video fails to load, the game offers a "paste a
> different YouTube URL" fix-up on the spot (stored as an override). BPMs
> are approximate — verify by tapping and adjust via a custom song if a
> seed feels off.

## Stats & sync

- Dashboard: accuracy trend, timing-error histogram, per-song bests, session
  history, blind-streak records.
- Everything is stored in `localStorage` first. Optional free cloud sync to
  your own Google Sheet via Apps Script — see
  [docs/GAS-SETUP.md](docs/GAS-SETUP.md). Export/Import JSON from Settings
  for manual backups.

## Development

- `node js/engine.test.mjs` — unit tests for the pure scoring/anchoring
  engine (no framework needed).
- In the game view: press **D** for a debug overlay (clock-mapping slope,
  residuals, grid phase), **A** to toggle an autotap robot that taps on the
  grid (should score ~100% — end-to-end sanity check of the whole timing
  pipeline).
