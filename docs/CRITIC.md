# Evaluation Protocol

How this project decides whether a frame is good enough. Four independent
instruments, run every pass. All four must move together — a score that climbs
while the forensic test still says "WebGL" is a score that is lying.

---

## Instrument 1 — Lens critique (diagnostic)

Three harsh reviewers, each restricted to one lens so they cannot average away a
specific failure behind a general impression:

| Lens | Judges |
|---|---|
| `atmosphere-and-light` | scattering, aerial perspective, shadow quality/softness/stability, colour temperature separation, filmic grade |
| `material-and-detail` | tiling, multi-scale variation, micro-detail, erosion plausibility, aliasing/shimmer/moiré |
| `composition-and-believability` | silhouette, sense of scale, depth layering, does it read as a real place |

Scale, deliberately stingy:

```
1  broken
3  typical three.js demo
5  competent indie
7  good AA game
9  shipped AAA
10 RDR2 marketing screenshot
```

Every finding must name **shot + defect + the specific rendering technique that
fixes it + owning system**. "Needs more detail" is rejected as a finding.

---

## Instrument 2 — Forensic provenance test

Complements Instrument 3. Rather than diffing
against copyrighted reference frames, we invert the test:

> An agent with **no knowledge of this project** is shown a single frame and asked:
> *"Is this a screenshot from a shipped AAA console game, or from a browser/WebGL
> hobby project? State your confidence and list the specific visual tells that
> gave it away."*

The reviewer holds RDR2 and its peers in mind as the reference class — no asset
redistribution required. What makes this the sharpest instrument we have:

- It cannot be gamed by a pretty-but-fake image, because the agent is hunting for
  evidence rather than assigning a grade.
- **Every tell it names is a bug report.** "The grass is all the same height and
  the same green" is worth more than any score.
- It degrades gracefully: as quality rises, confidence drops toward "uncertain",
  and *uncertainty is the win condition* — not a claimed victory over RDR2.

Recorded per pass as `verdict ∈ {AAA, uncertain, hobby}` plus `confidence 0-100`
and the tell list.

**Target: the majority of shots reach `uncertain` or better, with the tell list
exhausted of anything structural.**

---

## Instrument 3 — Blind A/B against real RDR2 gameplay

The direct comparison. `tools/abcompare.py` pairs each of our captures with a
matched **in-game gameplay** frame and emits two things:

1. **Full-frame side-by-side**, labelled only `A` and `B`. Side assignment is a
   per-shot hash — deterministic, but not guessable from the filename — and the
   answer key is written to a *different directory* so a reviewing agent reading
   the image folder cannot find it.
2. **1:1 matched crops** of four semantic regions (foreground ground, midground
   mass, distant edge, sky), stacked A over B at native pixel scale.

The crops are the sharper of the two. A full frame invites a composition
judgement; a 1:1 crop of the same semantic region strips composition away and
leaves nothing but material, detail bandwidth, aliasing and light integration.
First run against pass 2, `forest_interior__crop_midground_mass` showed our
canopy as high-frequency chaos with black alpha-test speckle beside a soft
coherent volume with light shafts through it — a diagnosis no full-frame score
had produced in three passes.

**Reference selection rules** (both matter, and both were corrected after a
first attempt got them wrong):
- **Gameplay, not marketing.** Publisher promo screenshots are staged cinematic
  captures — portrait framing, cinematic camera, hand-set DOF. Comparing against
  them sets a bar that is not the game. The reference set is user-captured
  in-game frames.
- **HUD-free.** A visible minimap instantly identifies which side is the shipped
  title and destroys the blind. Frames with HUD were rejected from the pairs
  even though they are the best *proof* of gameplay provenance.
- Matched for time of day, scene type and subject, so the comparison is about
  execution rather than content.

**Honest limitation.** Blinding is imperfect: RDR2 is famous, and a reviewer may
simply recognise it — Arthur Morgan's silhouette is not anonymous. So the
*verdict* ("which is better") carries less weight than the **diff**. The
instrument earns its place because of what it enumerates, not what it declares.
The prompt therefore demands a concrete difference list and treats the
preference as secondary.

Reference frames live in `refs/` and are **gitignored** — used transiently as
critique reference, never redistributed, never part of the deliverable.

---

## Instrument 4 — Budget check (objective)

Pulled from `stats()` in every capture report. A beautiful frame that runs at
4 fps is not shipped quality.

| Metric | Ceiling at `ultra`, 1080p |
|---|---|
| draw calls | 2000 |
| frame time | 16 ms on an M3 Pro |
| console errors | 0 |
| failed systems | 0 |

---

## Termination

The loop runs until **convergence, not until victory**. It stops when either:

- **Converged** — the mean lens score gains < 0.3 across a full pass AND the
  forensic tell list produces no new structural defects. Further passes are
  polishing noise; the remaining gap is budget, not technique.
- **Ceilinged** — remaining findings are all things WebGL genuinely cannot do
  (no mesh shaders, no hardware RT, no 100GB streaming asset budget, one
  thread for game logic). These get recorded in `docs/CEILING.md` rather than
  chased.

Honest statement of the bar: a browser build will not beat RDR2 in a fair blind
comparison, and the loop is not permitted to claim it has. What it *can* do is
reach the point where a viewer cannot immediately tell the frame came from a
browser — and that is the target being optimised.

---

## Pass log

| Pass | Lens avg | Forensic | Draws | ms | Note |
|---|---|---|---|---|---|
| 0 | — | — | 3 | 0.03 | baseline: bare heightfield + gradient sky |
| 1 | **2.67** | not run | 48 | 10.3 | engine works, world is empty |
| 2 | **4.33** | 6/6 hobby @ 96 | 323 | 15.2 | world populated, real scattering physics |
| 3 | **5.33** | 6/6 hobby @ 95 | 163 | 18–58 | shadows + AA land; **perf regresses to 10/10 over budget** |
| 4 | **4.00** | 3/3 hobby @ 93 | 152 | 12–20 | perf +33%, boot −53%; **lens regresses**, sun-ghost bug returns |

### Pass 3 — the instruments disagree, and the disagreement is the finding

Lens: atmosphere **5→6**, surfaces **4→5**, believability **4→5**. Mean
**4.33 → 5.33**. Forensic: **96 → 95**. Effectively unmoved.

This is precisely the failure mode the header of this document warns about. The
lens critics reward improvement; the forensic examiners hunt for evidence and do
not care that a frame is better than it was. Three passes of defect-list
grinding moved the lens score 2.67 points and the forensic verdict one point.

Two things caused the strategy change at pass 4:

1. **Performance regressed badly.** Pass 2 had three shots under 16.7 ms; pass 3
   has *zero*, and `night_camp` went 44 → 58 ms (17 fps). The pass-3 shadow and
   AO work bought quality with frame time nobody was tracking as a gate. A
   beautiful frame at 17 fps is not a playable game.
2. **The blind A/B relocated the problem.** Run against pass 3, the comparison
   shows the *rendering* is now broadly right — shadows rake correctly at golden
   hour, there are real blacks, aerial perspective stacks. What is left is not
   rendering technique, it is **art direction**: clouds that are solid opaque
   amoebas with hard edges, and props sprinkled at uniform density across the
   whole landscape like confetti, with no massing, no size hierarchy and no
   empty ground. The reference frame has dense forest gripping a slope, bare
   outcrop, open meadow, and a dark foreground anchor. Ours has objects
   distributed evenly on a heightfield.

**Lesson recorded:** the defect-list loop optimises what the list measures. Once
the list is mostly bugs, it converges. It cannot see a missing *idea* — like
"this landscape has no composition" — because that is not a defect in any single
pixel. The A/B against real gameplay is what surfaced it.

### Pass 1 — what the instruments said

Lens scores: atmosphere-and-light **3**, material-and-detail **3**,
composition-and-believability **2**. Agent self-scores on the same work: 7–8.

That 5-point gap is the single most useful number produced so far. Self-assessment
by the author of the work is worthless here; the harsh independent critic is not
a formality, it is the only functioning instrument.

**41 findings — 14 critical, 18 high.** Two classes:

*Class A — real bugs, objectively verifiable.* The critics did not merely emote,
they measured, and everything they measured was reproducible:
- **Three sun discs** in `golden_hour_vista`, blobs at (1311,235), (1590,244),
  (601,278). Four in `river_bend`. On the hero shot. Nobody who built the sky
  noticed.
- **Aerial perspective chromatically inverted** — B−R *negative* on distant
  terrain in 6 of 7 daylight shots (worst: `player_third_person` −0.123). Distant
  ridges were coming out warmer than the foreground, the exact opposite of the
  physics. Confirmed by eye on `high_noon_desert`: the far mesas are saturated
  red-brown where they should desaturate toward the sky.
- **Local contrast increasing with distance** (far ridge luma σ 0.117 vs near
  plain 0.028) — the tonal signature of the same missing extinction term.
- **Quantised heightfield** producing stair-stepped ridge silhouettes.
- **Non-monotonic luma steps** down mesa faces (0.803→0.589 then back *up* to
  0.609) proving the strata banding was a height-ramp artifact, not geology.

*Class B — the world was empty.* Six of ten shots contained zero authored
content. `town_street` had no town, `forest_interior` no trees, `river_bend` no
river, `player_third_person` no player. 48 draw calls and 7 geometries across an
"open world". The engine was real; the game was not.

**Method note.** Ten of the ten pass-1 agents ran the capture harness and
reported clean smoke tests. Five reported self-scores of 8. The harness proves a
frame *rendered* — it cannot tell you the frame is *good*. Only an adversarial
reader of the actual pixels closes that loop, and it has to be one with no stake
in the code.

---

### Pass 2 — the forensic test earns its keep

Lens scores: atmosphere **3→5**, material **3→4**, believability **2→4**. Mean
**2.67 → 4.33**. Both critical pass-1 render bugs died, and the fixes were
diagnosed rather than clamped:

- **The three suns were never three suns.** Root cause was the display grade
  running contrast 1.13 + gain 1.045R *on top of* AgX, pushing three small
  sunlit cumulus past 1.0 where they clipped flat and lost every internal
  gradient — then the bloom prefilter gave each flattened puff its own halo. The
  sun disc had been a single analytic term all along. Blob count now 0 at
  threshold 0.965/0.90/0.85, and exactly 1 when the camera is pointed at the sun.
- **Aerial perspective was sampling the wrong integral.** In-scatter came from
  the sky-view LUT — the asymptotic airlight of an *infinite* path, reddened by
  100 km of extinction a 2–10 km ridge never traverses. Measured at golden hour,
  120° from the sun, the LUT reads R:G:B = 1 : 0.58 : 0.28 where the true local
  source function is 1 : 1.05 : 0.36. Replaced with a real segment source
  function; aerosol given an Ångström exponent of 1.3 so blue now extinguishes
  2.28× faster than red instead of 1.48×.

**But six blind forensic examiners each said HOBBY, at 94–97% confidence.**

That is the finding that matters, and it is worth being precise about *why* it
outranks the lens scores: the lens critics were grading a picture, and a picture
that goes from empty to populated grades better. The forensic examiners were
hunting for evidence, and evidence does not care about improvement. Their 80
tells converged, independently, on three things the lens scores had largely
priced in as "medium":

1. **No cast shadows, no contact shadows, no AO.** Named in 5 of 6 reports. A
   wagon under a hard low sun casting nothing, beside a building throwing a
   400px shadow. Trunks meeting ground with a hard silhouette edge.
2. **No anti-aliasing.** Sky-to-rock silhouette transitions resolving in a single
   pixel; midground shimmer at per-pixel delta σ 21.9 against 1.0 in the sky.
3. **Placeholder surfaces at hero scale.** A foreground boulder filling 20% of
   frame with no pores, cracks or normal detail. Leaves as flat uniform-fill
   ellipses. Logs as open-ended hollow tubes with no end caps.

Plus hard bugs no lens critic caught: a missing-texture checkerboard rendering
in-world, a broken instanced mesh drawing as a diagonal hatch lattice, magenta
minification breakdown, and a max pixel value of 235 across an entire high-noon
desert frame — i.e. no HDR headroom at all.

**Two regressions**, both recorded: `storm_plains` went from the one shot with
correct depth physics to a milk white-out where the darkest pixel in frame is
mid-grey (0.1st-percentile luma 0.317); and the `night_camp` boulders went from
"grey plastic lumps" to *blown-out white* plastic lumps — the new fire key light
exposed the untextured surface instead of hiding it.

**Conclusion carried into pass 3:** the lens score is a lagging indicator. The
forensic tell list is the leading one, and it is the actual work queue.


### Pass 4 — the blind A/B returns its verdict: **RDR2 10, us 0**

First run of Instrument 3 against real in-game gameplay frames. The judge saw
shuffled A/B pairs with no knowledge of provenance, and picked **A on four shots
and B on six** — i.e. it was not favouring a side. Decoded against the key,
**every one of those ten picks was RDR2.** Gap assessed as "large".

This is the honest answer to the original brief. A browser build did not beat a
$500M native title, and now that is measured rather than asserted. What the
instrument is *for* is the 32 enumerated differences it produced, which are worth
more than the scoreline.

**Lens score regressed 5.33 → 4.00**, and the reason matters:

- **A dead defect came back.** `storm_plains` now ships ~12 stacked sun ghosts in
  a vertical ladder — the same class as pass 1's three sun discs, in a new shot.
  `metrics.py` caught it automatically (`single_sun` red). This is the immune
  system working exactly as designed, one pass after being built.
- Clouds improved but only partially; massing improved **only where a scene was
  hand-composed** (`town_street`), not where props are procedurally scattered.

**Performance was the real win, and it was won by measurement.** The agent built
its own ablation bench first and *overturned the brief's stated suspects* — the
campfire spot shadow, PCSS taps and night volumetrics were all under 1.5 ms. The
actual costs were:
1. **Two synchronous `readRenderTargetPixels` per frame** (auto-exposure and the
   sky-view probe), each draining the GPU pipeline and serialising CPU with GPU.
   Replaced with a WebGL2 pixel-pack-buffer ring.
2. **Terrain drawing FIRST** (`renderOrder -1`), so its ~25-fetch fragment shader
   ran on every pixel of every frame and was then painted over. Moving it to draw
   last among opaque, so early-Z rejects covered ground, was worth 3.5–5.1 ms by
   itself.

Result: night_camp 18.9 → 12.7 ms, town_street 30.2 → 18.1, forest_interior
28.3 → 20.1, boot 15.3 → 7.2 s. Three of ten now under budget; the profile is
flat afterwards (ten subsystems at 0.3–3.0 ms), so the rest needs a broad cut
rather than a hot-spot fix.

**A measurement-integrity failure worth recording.** Removing those blocking
readbacks also removed the accidental GPU synchronisation that `engine.frameMs`
had been relying on. The number kept being reported and kept looking plausible
while measuring nothing — it swung 13–46 ms on identical builds, and
`metrics.py`'s `frame_budget` gate was silently grading against it. Fixed by
timing a batch of frames and forcing completion **once** at the end
(`stats.gpuFrameMs`), so one stall is amortised over 30 frames. *An optimisation
can invalidate an instrument. When the thing being measured changes, re-validate
the meter.*
