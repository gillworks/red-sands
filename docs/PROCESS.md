# Process — how this project is built and judged

Durable notes for future sessions. Read alongside `CONTRACTS.md` (interfaces +
art direction) and `CRITIC.md` (evaluation protocol + pass log).

The short version: **agents build, independent adversaries judge, and everything
a judge ever found becomes an automated assertion so it can never come back.**

---

## 1. The loop

```
 brief (defect list, pre-digested)
   → N parallel build agents, each owning disjoint files
   → integrator (only role allowed to edit across systems)
   → judges, in parallel:
        · lens critique       (art direction, scored)
        · forensic provenance (AAA or hobby? list the tells)
        · blind A/B vs RDR2   (matched gameplay frames)
        · champion ladder     (vs the previous pass)
        · scripted metrics    (regression suite, no model)
        · motion critique     (temporal artifacts)
   → findings routed back per owning system → next pass
```

**Why agents cannot judge their own work:** pass-1 agents self-scored 7–8 on
work the critics scored **2.67**. Pass-2 agents did it again. By pass 3 the
self-scores had fallen to 5–6 against a critic score of 5.33 — they only
calibrated after being shown the gap twice. Never let the builder grade the build.

---

## 2. The instruments

| Tool | What it catches | Cost |
|---|---|---|
| `tools/capture.mjs` | renders the 10 canonical shots headless on the real GPU | 15s boot + ~5s/shot |
| `tools/metrics.py` | **regression suite** — every dead defect, permanently asserted | seconds |
| `tools/motion.py` | **temporal artifacts** — shimmer, LOD pop, ghosting | ~1 min |
| `tools/abcompare.py` | blind A/B vs real RDR2 gameplay, and champion ladder | seconds |
| `tools/scout.mjs` | adversarial camera — hunts the ugliest frame in the world | ~5 min |
| lens / forensic agents | art direction, and "does this read as shipped" | slow |

```bash
# iterate cheap (1280x720, medium, 48 settle frames — ~4x cheaper)
node tools/capture.mjs --fast --out shots/_me --only golden_hour_vista

# full set, then the automated judges
node tools/capture.mjs --out shots/passN --w 1920 --h 1080
python3 tools/metrics.py --shots shots/passN --baseline shots/passN-1

# temporal — the instrument still frames are blind to
node tools/capture.mjs --motion --fast --out shots/motionN --frames 24
python3 tools/motion.py --dir shots/motionN

# blind A/B against real gameplay, and against our own previous pass
python3 tools/abcompare.py --ours shots/passN --ref refs/rdr2 \
        --out shots/abN --keydir <somewhere-else>
python3 tools/abcompare.py --ours shots/passN --champion shots/passN-1 \
        --out shots/ladderN --keydir <somewhere-else>

# does it survive a camera we did not choose?
node tools/scout.mjs --out shots/scoutN --n 40 --worst 6
```

---

## 3. `metrics.py` — the immune system

**The single highest-leverage thing in this repo.** Pass 2 regressed two
already-fixed defects (the storm white-out, the blown boulders) because a fixed
defect had no immune system — nothing was watching. Critics were already
computing these numbers by hand in prose; this makes them a gate.

Every assertion traces to a defect that was **once real here**:

| Gate | Historical defect it locks down |
|---|---|
| `single_sun` | pass 1 rendered **three sun discs** in the hero shot |
| `aerial_perspective_hue` | B−R *negative* with distance — distant ridges warmer than foreground |
| `aerial_perspective_contrast` | local contrast *rose* with distance instead of compressing |
| `has_blacks` | pass-2 storm white-out: darkest pixel in frame was 0.317 |
| `hdr_headroom` | max channel 235 across an entire noon frame — no highlight range |
| `anti_aliased` | sky→terrain silhouette resolving in a single pixel |
| `grass_not_emerald` | grass saturation 0.43 against a 0.15–0.25 target |
| `no_chroma_artifacts` | missing-texture checkerboards rendering in-world |
| `frame_budget` / `boot_budget` | pass 3 put **all ten** shots over budget |

**Validated by replay:** run against `shots/pass1` it independently rediscovers
the hand-found defects — `golden_hour_vista` = 3 blobs, AA = 0.00, green
saturation 0.404, max channel 238 — and against `shots/pass2` it flags
`storm_plains` p01 luma at **0.317**, the exact figure the critic reached by eye.

Distance is proxied by vertical position below a detected horizon, not a depth
buffer. It is a proxy — but a *consistent* one, which is all a regression gate
needs. Do not read the absolute numbers as physics.

---

## 4. `motion.py` — temporal critique

Every other instrument judges frozen frames, and **the strongest WebGL tells are
temporal**: cascade shimmer, TAA ghosting on alpha-tested foliage, LOD pop,
specular crawl. A perfect screenshot can come from a frame that boils.

- `static/` — camera frozen, N frames. Any pixel that changes is an artifact.
  Per-pixel temporal σ becomes a heatmap and a gate (`σ < 0.004`).
- `dolly/` — camera tracking forward. A steady dolly should give a steady
  frame-to-frame delta; a *spike* is an LOD/impostor switch announcing itself
  (`pop_ratio`). Also emits a 6×4 filmstrip so a vision critic can judge motion
  from one image.

**Found on its first run:** 1.7% of pixels boiling with a frozen camera, and the
heatmap localised it exactly — every tree's branches, plus the entire ridge
silhouette. Three passes of still-frame critique had never seen it.

---

## 5. Blind A/B and the champion ladder

`abcompare.py` pairs each capture with a matched **in-game gameplay** frame
(`refs/`, gitignored) and emits a full-frame side-by-side plus **1:1 matched
crops** of four semantic regions.

- **The crops are the sharper instrument.** A full frame invites a composition
  judgement; a 1:1 crop of the same region strips composition away and leaves
  only material, detail bandwidth, aliasing and light integration.
- **Gameplay, not marketing.** Publisher promo shots are staged cinematic
  captures; comparing against them sets a bar that is not the game.
- **HUD-free.** A visible minimap identifies the shipped title instantly and
  destroys the blind — so the frames that best *prove* provenance are exactly
  the ones that cannot be used.
- Side assignment is a per-shot hash; the key is written to a different
  directory so a reviewing agent cannot find it.
- **Blinding is imperfect** — RDR2 is recognisable. So the *diff* is the
  deliverable and the *preference* is secondary. The prompt demands an
  enumerated difference list.

**Champion ladder** (`--champion <prev>`): each pass also fights its own parent,
blind, per shot. A pass that loses to its parent has regressed. Pass 2's
regressions were caught by a diligent reviewer noticing; this makes it structural.

---

## 6. `scout.mjs` — adversarial camera

Ten canonical shots are ten viewpoints, and anything judged only there gets
overfitted to them. **RDR2 survives any camera; that is the real bar.** Scout
walks seeded random poses across the world at random hours and weather, scores
each cheaply (blown / crushed / no tonal range / chromatically dead / slow), and
writes out the ugliest as new findings. No model in the loop.

---

## 7. Per-system cost attribution

`Engine.frame()` keeps a rolling EMA of every system's CPU time; `stats()`
returns `systemMs` sorted worst-first. Pass 3 put every shot over budget and
nobody could name the offender — an unattributed frame time is an unfixable one.

First run was immediately decisive: `__render` **28.5ms of a 29.7ms frame**,
with all twenty systems' update logic totalling ~1ms. The cost is entirely in
the render path, not game logic.

**Limitation, stated honestly:** this is CPU submission time, not GPU execution.
WebGL is asynchronous, so a heavy shader appears here only via backpressure.
For true per-pass GPU numbers use `EXT_disjoint_timer_query_webgl2` around each
pass — not yet built.

---

## 8. Speed discipline

Measured bottlenecks, in order:
1. **Agents re-deriving context.** Ten agents each loading ~100k tokens of docs
   and source before writing a line. Fixed by fewer agents with bigger mandates
   and **pre-digested briefs** — put the defect list *in the prompt*, and forbid
   reading the big findings JSONs.
2. **Boot at 15–26s**, paid by every capture by every agent forever. Budget is
   5s; `capture.mjs` now warns loudly above 6s.
3. **Iterating at full quality.** `--fast` is ~4× cheaper; only the final
   reported capture needs 1080p/ultra.
4. **Timid increments.** Six small rounds cost the same wall clock as two big
   ones and converge slower. Brief says: biggest change first, look, one
   correction.

---

## 9. Lessons that cost a pass each

- **The defect-list loop optimises what the list measures.** Once the list is
  mostly bugs, it converges — and it structurally cannot see a missing *idea*
  ("this landscape has no composition"), because that is not a defect in any
  single pixel. Only the A/B against real gameplay surfaced it.
- **Lens score is a lagging indicator; the forensic tell list is the leading
  one.** Passes 1→3 moved the lens score 2.67 points and the forensic verdict
  one point. Trust the tells.
- **Diagnose, never clamp.** The "three suns" were not three suns — the grade
  was pushing cumulus past 1.0 where they clipped flat, and bloom haloed each
  one. The fix was in the tonemap, nowhere near the sun disc.
- **A quality gain that blows the frame budget is a regression.** Make perf a
  gate, not a consideration.
- **Fixed defects need an immune system**, or they come back. See §3.

---

## 10. Adopted from external review — and what was not

Incorporated: motion critique (§4), metrics-as-regression-suite (§3), champion
ladder (§5), adversarial camera scout (§6), per-system cost attribution (§7).

**Composition as an owned system — adopted as a contract change, pass 5.**
The pass-3 lesson ("confetti props, no massing") is a defect *no per-system
builder can fix*, because composition is cross-system and the contracts forbid
cross-file edits. The fix is to give it an owner: a `composition` system that
writes shared distribution fields into `ctx` — density masks, cluster maps,
negative-space reserves, landmark placements — which `vegetation`, `scatter` and
`town` must all sample rather than each rolling their own placement. That turns
"no idea" into an interface. Not yet built.

**Parameter optimisation (CMA-ES) — measurement half only, for now.**
The argument is sound: cloud coverage, clustering falloffs, palette, fog, grade
are ~100 continuous scalars; LLMs are bad at "nudge fog 12%" and optimisers are
superhuman at it. What is cheap and real today is the *fitness* side — palette
and tonal statistics measured against the reference board, which is what
`metrics.py` already begins. The expensive part is exposing every tunable as a
flat genome, which is a large refactor across systems currently being edited.
Sequence: parameterise during a quieter pass, then optimise. **Goodhart guard is
mandatory** — if a fitness score climbs while the frozen forensic examiner still
says "hobby 95%", the scorer is being gamed and must be reweighted.

**Audio gauntlet — deliberately deprioritised.** Spectrograms and LUFS against
reference ambience is a reasonable idea, but the deliverable is judged visually,
no critic has yet raised audio as a defect, and the project is time-constrained.
Recorded here so the decision is visible rather than forgotten.

**img2img "dream target" — promising, unbuilt.** Take our actual capture, push
it toward the reference style, and use the result as a *same-composition,
pixel-aligned* target, so the A/B diff becomes directly actionable ("mass the
trees on the left slope, darken the foreground") in a way a different-content
RDR2 frame never can be. Treat strictly as art direction, not ground truth — the
model will paint physically impossible light. Worth trying next.

---

## 11. Human playtest > agent critique

Once the build was playable, one human playing it for a few minutes produced
better findings than a whole pass of critic agents. Recorded because it should
change how later passes are sequenced: **get to playable early, then let real
play drive the queue.**

What a human caught that every automated instrument had missed:

| Report | Why the instruments missed it |
|---|---|
| Rider floats above the saddle | No canonical shot framed the mount closely; stills never showed the gap |
| NPC animals "zip around", unreal | Purely temporal, and the motion gate only watched a *static* camera |
| Flickering dark band on terrain | Intermittent — absent from most captures. A screenshot suite samples one instant per shot |
| Movement smear when riding | Only appears under player-driven motion, which no capture reproduced |

The pattern: **screenshot suites sample one instant of one camera path.** Bugs
that are intermittent, motion-only, or framed outside the ten canonical shots are
structurally invisible to them. The adversarial camera scout (§6) addresses the
framing half; nothing but real play addresses the rest.

### Worked example — diagnose before delegating

The flicker report was ambiguous (cascade shimmer? cloud shadow? z-fighting?), so
it was bisected in the live browser before any agent was briefed: sample mean
luma of the midground band over 24 frames while drifting the camera, toggling one
suspect at a time.

```
baseline                      maxFrameJump 0.04536
clouds.shadowStrength = 0     maxFrameJump 0.00466   <- 10x drop, culprit
lighting.csm.strength = 0     maxFrameJump 0.00185
```

Root cause, `src/render/Clouds.js` ~line 719:

```js
this.shadowExtent = 5400 + 4200 * smooth01(sunY / 0.75); // recomputed EVERY frame
const texel = (this.shadowExtent * 2) / this.shadowRes;  // so texel size moves too
const cx = Math.round(cam.position.x / texel) * texel;   // snapping to a MOVING grid
```

The centre *was* texel-snapped — correct practice — but the extent is derived
continuously from sun altitude, so the grid spacing itself changes every frame.
**Snapping to a grid whose spacing is moving accomplishes nothing**: the centre
jitters and the whole projection rescales, which is the band that swims across
the terrain. Fix is to quantise the extent into discrete steps with hysteresis,
exactly as `CascadedShadowMaps` already does for cascade extents.

Two lessons worth keeping:
1. **Diagnose ambiguous reports yourself before delegating.** Ten minutes of
   bisection turned "there's a flicker" into a named line of code, and the agent
   got a verification target (`maxJump` must reach ~0.005 *with cloud shadows
   still on*) instead of a hunt.
2. **A correct technique applied to an unstable input is still a bug.** The
   texel snap, the cascade fit and the TAA history all share this failure shape —
   each is right only if what it is quantising against holds still.

---

## 12. When the instrument is the bug

Two of this project's instruments were silently broken, and both were found by
*agents doing the work*, not by the instruments themselves. Both are worth
remembering because the failure shape recurs.

### 12.1 The harness froze the clock

`?capture=1` pauses `TimeOfDay` so screenshots are bit-reproducible. Correct for
determinism — and it made `metrics.py` and `motion.py` **structurally blind to
every sun-rate-driven defect.**

That is precisely how the cloud-shadow flicker reached a human playtester with no
gate firing. All three of its root causes were functions of sun altitude, and in
every automated capture the sun never moved. The fixing agent proved it: with the
clock frozen, the pre-fix and post-fix builds produce *byte-identical* projection
state, and its own before/after motion numbers came back unchanged.

Fix: `capture.mjs --motion` now records a third sequence, `suncycle/`, with the
camera frozen and the **clock running fast** (90s day). A smooth lighting sweep
is expected; a *step* is the defect. `motion.py` gates on
`sun_step_ratio = max frame delta / median frame delta` — a sweep gives ~1.0, a
staircase spikes. Calibrated at 2.2: the broken build measured 2.47, the fixed
one 1.29, and the repaired full-frame reading is 1.04.

### 12.2 The dolly was a no-op

`motion.py`'s LOD-pop test advanced the camera with
`cam.position.addScaledVector(fwd, 0.9)`. But `CameraRig.setFreeCamera` latches a
pose and **reasserts it every `update()`**, so the camera never moved and the
test measured a static scene while reporting a healthy `pop_ratio`. Two agents
found it independently. Fix: re-latch through `rig.setFreeCamera()` each step.
`maxDelta` went 0.0073 → 0.0181, i.e. it is now actually dollying.

### 12.3 The optimisation that invalidated the meter

Pass 4 replaced two per-frame `readRenderTargetPixels` calls with an async PBO
ring — a genuine 33% win. Those calls had also been *accidentally* synchronising
`engine.frameMs`. The number kept being reported, kept looking plausible, and
measured nothing (13–46 ms on identical builds), with `metrics.py`'s
`frame_budget` gate silently grading against it. Fix: time a batch and force
completion **once** at the end (`stats.gpuFrameMs`), amortising one stall over 30
frames.

**The pattern in all three:** an instrument kept returning confident,
plausible-looking numbers after the thing it measured had changed underneath it.
None failed loudly. Practical rules:

1. **Determinism controls create blind spots.** Anything frozen to make a test
   reproducible is a dimension the test can no longer see. List them explicitly:
   here, time. Then build one instrument that deliberately unfreezes each.
2. **Validate a gate against a known-broken build.** A gate that has never fired
   is not proven; it is unproven in the most dangerous way. Every threshold in
   `metrics.py` was calibrated by replaying it against the pass where the defect
   was live.
3. **When you optimise, re-validate the meters that touched what you changed.**
4. **A test that cannot fail is worse than no test**, because it is also a claim.

---

## 13. What parallel fan-out can and cannot do

Pass 10 fanned seven agents across the visual pipeline at once: character/horse,
vegetation, ground surface, volumetric light, clouds/sky, town richness, grade.
Every agent verified its own work and reported success. The lens critic scored
the result **4/10, down from 5.33**, with regressions in clouds, saturation,
highlights and composition.

**The rule this establishes:**

> Parallel fan-out works for systems that own **disjoint outputs**. It fails for
> systems that all write to the **same final pixel**.

Vegetation owns instances. Character owns a mesh. Those parallelise cleanly, and
both were genuine wins. But grade, clouds, sky, volumetrics and lighting all
compose into one image — so when the grade agent desaturated globally, the
character agent was concurrently measuring its horse against a moving target and
could not see it. Each agent's isolated verification was **honest and correct in
isolation, and jointly worthless.** The character agent even flagged this in its
own report: a highlight bug appeared in `town_street`, a shot containing neither
the player nor the horse, so it correctly deduced the cause was someone else's.

**Corrective structure**, used in the repair pass: the ENTIRE image pipeline gets
ONE owner (Clouds + Sky + PostFX + Grade together), so every change is judged on
the composited result by the agent making it. World content — which owns
geometry, not pixels — stays parallel.

**The instruments disagreed, and both were partly right.** Objective gates
*improved* sharply in the same pass the lens critic marked down:

| | pass 9 | pass 10 |
|---|---|---|
| frame_budget failures | 8 | **0** |
| hdr_headroom | 2 | **0** |
| single_sun | 1 | **3** |
| total | 20 | **11** |

Adjudicating by eye: vegetation was transformed (species variety, clumping,
varied heights vs uniform tufts), the horse gained real tack, and every shot
came under frame budget — while the clouds became hard-edged blotches, the frame
desaturated, and a compositional landmark silently vanished. **Both instruments
were telling the truth about different things.** The lesson is not to trust one
over the other, but that a mixed pass needs adjudicating by looking, and the
regressions repaired without discarding the wins.

**Hence the champion ladder is now mandatory, not optional** (§5). A pass must
beat its own parent, blind, per shot. Pass 10 shipped four regressions that no
gate caught and no agent owned; a ladder run against pass 9 would have caught
them at the door.
