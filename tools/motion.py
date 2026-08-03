#!/usr/bin/env python3
"""
Temporal critique — the instrument every still-frame judge is blind to.

The strongest WebGL tells are temporal, not spatial: shadow-cascade shimmer,
TAA ghosting on alpha-tested foliage, LOD pop, specular crawl, dither that
never resolves. A perfect screenshot can come from a frame that boils.

Consumes what `capture.mjs --motion` writes:

  static/<shot>/f*.png   camera frozen. ANY pixel change here is an artifact.
  dolly/<shot>/f*.png    camera tracking forward. Reveals pop and ghosting.

Emits per shot:
  <shot>_shimmer.png     per-pixel temporal sigma as a heatmap (static)
  <shot>_filmstrip.jpg   6x4 contact sheet of the dolly, so a vision critic can
                         judge motion from a single image
  <shot>_pop.png         largest frame-to-frame delta in the dolly, which is
                         where LOD/impostor switches announce themselves

AND, unconditionally, the CAMERA-MOTION FLICKER gate (see `flicker_gate` below
and tools/flicker.mjs), which needs no capture directory because it drives its
own headless run.

  python3 tools/motion.py                    flicker gate only
  python3 tools/motion.py --dir shots/motion4  image sequences + flicker gate
"""
import argparse, glob, json, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Static-camera temporal sigma. Empirically: a clean frame sits near 0.000;
# visible shimmer starts to read around 0.004; pass-2 foliage measured far above.
SHIMMER_GATE = 0.004
POP_GATE = 0.055          # max single-frame mean delta during a steady dolly

# ---------------------------------------------------------------------------
# CAMERA-MOTION FLICKER GATE
#
# WHY IT EXISTS. A player reported "it only happens when the camera moves, and
# it's always the same distance from the camera — the ground and rocks just
# flicker dark past a certain distance". Both sequences above were blind to it:
#
#   static/  the camera does not move, so the artifact does not exist.
#   dolly/   the camera only TRANSLATES. The defect was an angular
#            misregistration of the shadow lookup (cascades 1-3 were composed
#            against a camera matrix up to 3 frames old, because the composed
#            uniform was written only inside the cascade fit, which runs on the
#            redraw stagger). A rotation error displaces the sampled point by
#            theta * distance; a translation error is a constant world offset
#            that the receiver-plane depth bias absorbs. Measured: a pure dolly
#            at 21 m/s shows NOTHING, a 60 deg/s pan shows an 11x excess.
#   both     judge WHOLE-FRAME deltas, and the band was ~6% of the pixels.
#
# So this gate PANS while it moves, and it bins the residual by TRUE
# camera-relative distance. Three statistics, all from one ~60 s run:
#
#  shadow_band_excess  per distance bin, how much dark-flicker the shadow system
#                      ADDS over the same path with the cascade lookup disabled.
#                      Content-independent: the floor is measured in the same
#                      run. Broken build 11.2, repaired build 0.28.
#  stagger_lock        autocorrelation of a bin's residual series at lags 2/3/4,
#                      i.e. the cascade refresh intervals. A band that flickers
#                      at exactly its own cascade's stagger period is a
#                      staleness bug and nothing else. Broken 0.98, repaired
#                      0.43 (= the shadows-off floor).
#  dark_band_peak      coarse net for a band from ANY system: the worst bin in
#                      20-160 m against the near-field floor inside cascade 0,
#                      which refreshes every frame and is always clean.
#                      Broken 14.4, repaired 3.1. Open-ground site only —
#                      a canopy site sets its own floor at 6+ from foliage.
# ---------------------------------------------------------------------------
# Calibration, measured on this build with tools/flicker.mjs --gate:
#                       repaired            pre-fix (--emulate stale)
#   shadow_band_excess  0.73 / 0.79         11.90 / 1.87
#   stagger_lock        0.46 / 0.37          0.98 / 0.53
#   dark_band_peak      2.85 / 5.73         14.35 / 5.48
# (desert / golden. Golden's canopy sets a high content floor, which is why the
#  peak check is gated on open ground only and the other two are ratios.)
FLICKER_EXCESS_GATE = 1.5    # shipped vs shadows-off, per distance bin
FLICKER_AC_GATE = 0.65       # |autocorr| at a cascade refresh interval
FLICKER_PEAK_GATE = 6.5      # worst 20-160 m bin / near-field floor
FLICKER_MIN_PIX = 300        # bins thinner than this are noise, not a band
FLICKER_PEAK_SITES = ("desert",)   # open ground + rocks: what the report is about


def load_seq(d, limit=None):
    fs = sorted(glob.glob(os.path.join(d, "f*.png")))
    if limit:
        fs = fs[:limit]
    if not fs:
        return None
    return np.stack([np.asarray(Image.open(f).convert("RGB"), dtype=np.float32) / 255.0
                     for f in fs])


def heatmap(x, path, gamma=0.45):
    """Scalar field -> perceptual heat image (black->red->yellow->white)."""
    v = x / max(x.max(), 1e-6)
    v = v ** gamma
    r = np.clip(v * 3.0, 0, 1)
    g = np.clip(v * 3.0 - 1.0, 0, 1)
    b = np.clip(v * 3.0 - 2.0, 0, 1)
    Image.fromarray((np.stack([r, g, b], -1) * 255).astype(np.uint8)).save(path)


def filmstrip(seq, path, cols=6, rows=4, w=440):
    n = min(len(seq), cols * rows)
    idx = np.linspace(0, len(seq) - 1, n).astype(int)
    h = int(seq.shape[1] * (w / seq.shape[2]))
    sheet = Image.new("RGB", (w * cols, h * rows), (14, 14, 14))
    for i, j in enumerate(idx):
        im = Image.fromarray((seq[j] * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS)
        sheet.paste(im, ((i % cols) * w, (i // cols) * h))
    sheet.save(path, quality=90)


def run_flicker(out_json, quiet=False):
    """Drive tools/flicker.mjs (its own vite + playwright) and return its JSON."""
    cmd = ["node", os.path.join(ROOT, "tools", "flicker.mjs"), "--gate", "--out", out_json]
    if not quiet:
        print("camera-motion flicker probe (panning camera, ~60s) ...")
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(out_json):
        return None, (r.stderr or r.stdout or "flicker.mjs failed").strip().splitlines()[-1:]
    return json.load(open(out_json)), None


def flicker_gate(data, quiet=False):
    """
    Evaluate the camera-motion flicker statistics. Returns (record, failures).

    `data` is what tools/flicker.mjs --gate writes: per site, per variant, the
    dark residual and the lag-2/3/4 autocorrelation of every camera-relative
    distance bin.
    """
    rec, failures = {}, []
    for site, sd in data.get("sites", {}).items():
        vs = sd.get("variants", {})
        if "shipped" not in vs:
            continue
        ship = vs["shipped"][0]
        floor = vs["shadowsOff"][0] if "shadowsOff" in vs else None
        edges, pix = ship["edges"], ship["pix"]

        near, worst_excess, worst_ac, worst_peak = [], (0.0, None), (0.0, None), (0.0, None)
        rows = []
        for b in range(len(edges) - 1):
            lo, hi = edges[b], edges[b + 1]
            if pix[b] < FLICKER_MIN_PIX:
                continue
            d = ship["dark"][b]
            # Cascade 0 refits every frame, so anything inside it is the clean
            # floor this content produces with no staleness of any kind.
            if hi <= 20.0:
                near.append(d)
            ex = None
            if floor is not None:
                f = max(floor["dark"][b], 1.0)
                ex = (d - floor["dark"][b]) / f
                if ex > worst_excess[0]:
                    worst_excess = (ex, (lo, hi))
            ac = max(ship["ac"][b]) if 20.0 <= lo and hi <= 260.0 else None
            if ac is not None and ac > worst_ac[0]:
                worst_ac = (ac, (lo, hi))
            rows.append((lo, hi, int(pix[b]), d, ex, ac))

        base = float(np.median(near)) if near else 1.0
        base = max(base, 0.5)
        for lo, hi, _p, d, _ex, _ac in rows:
            if 20.0 <= lo and hi <= 160.0 and d / base > worst_peak[0]:
                worst_peak = (d / base, (lo, hi))

        rec[site] = {
            "near_floor": round(base, 3),
            "shadow_band_excess": round(worst_excess[0], 3),
            "shadow_band_excess_at": worst_excess[1],
            "stagger_lock": round(worst_ac[0], 3),
            "stagger_lock_at": worst_ac[1],
            "dark_band_peak": round(worst_peak[0], 3),
            "dark_band_peak_at": worst_peak[1],
            "profile": [[round(lo, 1), round(hi, 1), p, round(d, 2)] for lo, hi, p, d, _e, _a in rows],
        }

        def at(t):
            return f"{t[0]:.0f}-{t[1]:.0f} m" if t else "n/a"

        if floor is not None and worst_excess[0] > FLICKER_EXCESS_GATE:
            failures.append((site, "no_camera_motion_shadow_band",
                             f"at {at(worst_excess[1])} the shadow system adds "
                             f"{worst_excess[0]:.2f}x its own shadows-off dark-flicker floor "
                             f"while the camera pans — a dark band at a fixed camera-relative "
                             f"distance"))
        if worst_ac[0] > FLICKER_AC_GATE:
            failures.append((site, "no_stagger_locked_flicker",
                             f"at {at(worst_ac[1])} the dark residual autocorrelates "
                             f"{worst_ac[0]:.2f} at a cascade refresh interval — that band is "
                             f"flickering in lock-step with the shadow redraw stagger"))
        if site in FLICKER_PEAK_SITES and worst_peak[0] > FLICKER_PEAK_GATE:
            failures.append((site, "no_camera_relative_dark_band",
                             f"{at(worst_peak[1])} flickers dark {worst_peak[0]:.1f}x the "
                             f"inside-cascade-0 floor ({rec[site]['near_floor']:.2f}) while the "
                             f"camera pans"))

    if not quiet and rec:
        print(f"\nCAMERA-MOTION FLICKER (panning camera, binned by camera-relative distance)")
        print(f"{'SITE':<10} {'floor':>7} {'shadowExcess':>13} {'staggerLock':>12} {'bandPeak':>9}  worst band")
        print("-" * 78)
        for site, r in rec.items():
            w = r["dark_band_peak_at"]
            print(f"{site:<10} {r['near_floor']:>7.2f} {r['shadow_band_excess']:>13.2f} "
                  f"{r['stagger_lock']:>12.2f} {r['dark_band_peak']:>9.2f}  "
                  f"{'%.0f-%.0f m' % (w[0], w[1]) if w else '-'}")
    return rec, failures


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=None,
                    help="directory written by capture.mjs --motion (optional)")
    ap.add_argument("--no-flicker", action="store_true",
                    help="skip the camera-motion flicker probe")
    ap.add_argument("--flicker-json", default=None,
                    help="evaluate an existing flicker.mjs --gate JSON instead of running it")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    out, failures = {}, []
    shots = (sorted(os.path.basename(p) for p in glob.glob(os.path.join(a.dir, "static", "*")))
             if a.dir else [])

    for shot in shots:
        rec = {}

        st = load_seq(os.path.join(a.dir, "static", shot))
        if st is not None and len(st) >= 4:
            gray = st.mean(-1)
            sigma = gray.std(axis=0)                    # per-pixel temporal sigma
            rec["shimmer_mean"] = round(float(sigma.mean()), 5)
            rec["shimmer_p99"] = round(float(np.percentile(sigma, 99)), 5)
            rec["shimmer_area"] = round(float((sigma > 0.02).mean()), 5)
            rec["frames_static"] = int(len(st))
            heatmap(sigma, os.path.join(a.dir, f"{shot}_shimmer.png"))
            if rec["shimmer_mean"] > SHIMMER_GATE:
                failures.append((shot, "temporal_stability",
                                 f"static-camera sigma {rec['shimmer_mean']:.5f} "
                                 f"> {SHIMMER_GATE} ({rec['shimmer_area']*100:.1f}% of pixels "
                                 f"visibly boiling)"))

        dl = load_seq(os.path.join(a.dir, "dolly", shot))
        if dl is not None and len(dl) >= 4:
            d = np.abs(np.diff(dl, axis=0)).mean(axis=(1, 2, 3))
            rec["dolly_delta_mean"] = round(float(d.mean()), 5)
            rec["dolly_delta_max"] = round(float(d.max()), 5)
            # A steady dolly should give a steady delta; a spike is a pop.
            rec["pop_ratio"] = round(float(d.max() / max(d.mean(), 1e-6)), 3)
            rec["frames_dolly"] = int(len(dl))
            filmstrip(dl, os.path.join(a.dir, f"{shot}_filmstrip.jpg"))
            k = int(np.argmax(d))
            heatmap(np.abs(dl[k + 1] - dl[k]).mean(-1),
                    os.path.join(a.dir, f"{shot}_pop.png"))
            rec["pop_frame"] = k
            if rec["dolly_delta_max"] > POP_GATE and rec["pop_ratio"] > 2.2:
                failures.append((shot, "no_lod_pop",
                                 f"frame {k}->{k+1} delta {rec['dolly_delta_max']:.4f} is "
                                 f"{rec['pop_ratio']:.1f}x the mean — discontinuous switch"))

        # suncycle: camera frozen but the CLOCK RUNNING. A slow, smooth lighting
        # change is correct and expected here; what is a defect is a STEP — a
        # frame where the whole image jumps because something re-quantised
        # against the sun. That is what the cloud-shadow flicker was, and it is
        # invisible to the other two sequences because they freeze the clock.
        sc = load_seq(os.path.join(a.dir, "suncycle", shot))
        if sc is not None and len(sc) >= 6:
            d = np.abs(np.diff(sc, axis=0)).mean(axis=(1, 2, 3))
            med = float(np.median(d))
            rec["sun_delta_median"] = round(med, 6)
            rec["sun_delta_max"] = round(float(d.max()), 6)
            # A smooth sweep has max ≈ median. A staircase spikes.
            rec["sun_step_ratio"] = round(float(d.max() / max(med, 1e-6)), 3)
            rec["frames_suncycle"] = int(len(sc))
            k = int(np.argmax(d))
            heatmap(np.abs(sc[k + 1] - sc[k]).mean(-1),
                    os.path.join(a.dir, f"{shot}_sunstep.png"))
            # Calibration: with the cloud-shadow bug live, the shadow map's own
            # spike ratio measured 2.47; after the fix, 1.29. Full-frame here
            # reads 1.04 on the repaired build. 2.2 sits between the fixed and
            # broken states, so this gate would have caught the original defect.
            if rec["sun_step_ratio"] > 2.2 and rec["sun_delta_max"] > 0.004:
                failures.append((shot, "no_sun_driven_step",
                                 f"frame {k}->{k+1} delta {rec['sun_delta_max']:.5f} is "
                                 f"{rec['sun_step_ratio']:.1f}x the median while only the "
                                 f"sun is moving — something re-quantises in a step"))

        out[shot] = rec

    if not a.quiet and shots:
        print(f"\n{'SHOT':<22} {'shimmer':>9} {'boil%':>7} {'popRatio':>9} "
              f"{'maxDelta':>9} {'sunStep':>8}")
        print("-" * 72)
        for shot, r in out.items():
            print(f"{shot:<22} {r.get('shimmer_mean',0):>9.5f} "
                  f"{r.get('shimmer_area',0)*100:>6.1f}% {r.get('pop_ratio',0):>9.2f} "
                  f"{r.get('dolly_delta_max',0):>9.4f} {r.get('sun_step_ratio',0):>8.2f}")

    # ---- camera-motion flicker (needs no capture dir; drives its own run) ----
    flick = {}
    if not a.no_flicker:
        if a.flicker_json:
            data = json.load(open(a.flicker_json)) if os.path.exists(a.flicker_json) else None
            err = None if data else [f"{a.flicker_json} not found"]
        else:
            dest = os.path.join(a.dir, "_flicker.json") if a.dir else \
                os.path.join(tempfile.gettempdir(), "rs_flicker.json")
            data, err = run_flicker(dest, a.quiet)
        if data is None:
            if not a.quiet:
                print(f"\ncamera-motion flicker probe SKIPPED: {' '.join(err or [])}")
        else:
            flick, ff = flicker_gate(data, a.quiet)
            failures.extend(ff)

    dest_dir = a.dir or "."
    json.dump({"shots": out, "flicker": flick, "failures": len(failures)},
              open(os.path.join(dest_dir, "_motion.json"), "w"), indent=1)

    if not a.quiet:
        if failures:
            print(f"\n{len(failures)} TEMPORAL GATE FAILURES:")
            for s, g, d in failures:
                print(f"  [{s}] {g}: {d}")
        else:
            print("\ntemporal gates pass")
        if shots:
            print(f"\nheatmaps + filmstrips written to {a.dir}/")

    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
