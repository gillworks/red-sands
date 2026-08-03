#!/usr/bin/env python3
"""
Regression suite for rendered frames.

Every gate below is a defect that was ONCE REAL in this project, found by a
critic, fixed, and is now permanently asserted so it cannot come back. Pass 2
regressed two already-fixed things (the storm white-out, the blown boulders)
because a fixed defect had no immune system. This is the immune system.

  python3 tools/metrics.py --shots shots/pass4
  python3 tools/metrics.py --shots shots/pass4 --baseline shots/pass3   # deltas
  python3 tools/metrics.py --shots shots/pass4 --json out.json

Exit code is non-zero if any gate fails, so it can run as a build gate.

Distance proxy: for landscape shots we bin by VERTICAL POSITION below the
detected horizon (lower = nearer). It is a proxy, not a depth buffer, but it is
consistent frame to frame, which is all a regression gate needs.
"""
import argparse, json, os, sys
import numpy as np
from PIL import Image

DAYLIGHT = {"golden_hour_vista", "high_noon_desert", "town_street",
            "river_bend", "forest_interior", "dawn_mist_valley",
            "player_third_person", "storm_plains"}
NIGHT = {"night_camp", "moonlit_ridge"}


def srgb_to_linear(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def luma(rgb):                      # rgb float 0..1
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def saturation(rgb):
    mx, mn = rgb.max(-1), rgb.min(-1)
    return np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)


def find_horizon(rgb):
    """First row from the top where the image stops behaving like sky."""
    h = rgb.shape[0]
    rowstd = rgb.reshape(h, -1, 3).std(axis=1).mean(axis=1)
    blue = rgb[..., 2].mean(axis=1) - rgb[..., 0].mean(axis=1)
    sky = (rowstd < np.percentile(rowstd, 45)) & (blue > -0.02)
    for y in range(int(h * 0.05), int(h * 0.92)):
        if not sky[y] and not sky[min(h - 1, y + 8)]:
            return y
    return int(h * 0.45)


def local_std(gray, k=8):
    """Mean of per-tile std — a cheap local-contrast measure."""
    h, w = gray.shape
    h2, w2 = (h // k) * k, (w // k) * k
    t = gray[:h2, :w2].reshape(h2 // k, k, w2 // k, k).transpose(0, 2, 1, 3)
    return t.reshape(h2 // k, w2 // k, -1).std(axis=2)


def blob_count(gray, thresh):
    """Connected components above a luma threshold (4-connectivity, iterative)."""
    mask = gray > thresh
    if not mask.any():
        return 0, []
    seen = np.zeros_like(mask, dtype=bool)
    h, w = mask.shape
    blobs = []
    ys, xs = np.nonzero(mask)
    for sy, sx in zip(ys, xs):
        if seen[sy, sx]:
            continue
        stack, n, cy, cx = [(sy, sx)], 0, 0, 0
        seen[sy, sx] = True
        while stack:
            y, x = stack.pop()
            n += 1; cy += y; cx += x
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        if n >= 60:                                   # ignore speculars/specks
            blobs.append({"px": int(n), "x": int(cx / n), "y": int(cy / n)})
    return len(blobs), sorted(blobs, key=lambda b: -b["px"])[:6]


def silhouette_aa(rgb, horizon):
    """
    Mean count of intermediate pixels across the sky->terrain edge.
    Pass 2 measured ~0 (a single-pixel step) which is the 'no AA' tell.
    """
    g = luma(rgb)
    widths = []
    band = g[max(0, horizon - 30):horizon + 30, :]
    if band.shape[0] < 8:
        return 0.0
    for x in range(0, band.shape[1], 7):
        col = band[:, x]
        hi, lo = col.max(), col.min()
        if hi - lo < 0.08:
            continue
        a, b = lo + 0.20 * (hi - lo), lo + 0.80 * (hi - lo)
        widths.append(int(((col > a) & (col < b)).sum()))
    return float(np.mean(widths)) if widths else 0.0


def analyse(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    rgb = a / 255.0
    lin = srgb_to_linear(a)
    g = luma(rgb)
    horizon = find_horizon(rgb)
    h = rgb.shape[0]

    m = {
        "max_channel": int(a.max()),
        "p01_luma": float(np.percentile(g, 0.1)),
        "p999_luma": float(np.percentile(g, 99.9)),
        "mean_luma": float(g.mean()),
        "mean_sat": float(saturation(rgb).mean()),
        "horizon_y": int(horizon),
        "silhouette_aa_px": round(silhouette_aa(rgb, horizon), 2),
    }
    m["dynamic_range"] = round(m["p999_luma"] - m["p01_luma"], 4)

    n, blobs = blob_count(g, 0.965)
    m["bright_blobs"] = n
    m["blobs"] = blobs

    # --- distance-binned aerial perspective, over the terrain region only ---
    top, bot = horizon + 4, h - 4
    if bot - top > 60:
        bands, nb = [], 5
        edges = np.linspace(bot, top, nb + 1).astype(int)      # near -> far
        for i in range(nb):
            y1, y0 = edges[i + 1], edges[i]
            seg_rgb = rgb[y1:y0, :, :]
            seg_g = g[y1:y0, :]
            if seg_rgb.shape[0] < 6:
                continue
            bands.append({
                "br": float(seg_rgb[..., 2].mean() - seg_rgb[..., 0].mean()),
                "sat": float(saturation(seg_rgb).mean()),
                "luma": float(seg_g.mean()),
                "lstd": float(local_std(seg_g).mean()),
            })
        if len(bands) >= 3:
            m["br_near"] = round(bands[0]["br"], 4)
            m["br_far"] = round(bands[-1]["br"], 4)
            m["br_gradient"] = round(bands[-1]["br"] - bands[0]["br"], 4)
            m["lstd_near"] = round(bands[0]["lstd"], 4)
            m["lstd_far"] = round(bands[-1]["lstd"], 4)
            m["contrast_gradient"] = round(bands[-1]["lstd"] - bands[0]["lstd"], 4)
            m["sat_gradient"] = round(bands[-1]["sat"] - bands[0]["sat"], 4)

    # --- grass hue/saturation: 'no cartoon emerald' (pass-1 defect, was 0.43) ---
    mx = rgb.max(-1)
    green = (rgb[..., 1] >= mx - 1e-6) & (mx > 0.08) & (saturation(rgb) > 0.05)
    if green.sum() > 500:
        m["green_sat"] = round(float(saturation(rgb)[green].mean()), 4)
        m["green_px_frac"] = round(float(green.mean()), 4)

    # --- extreme-chroma speckle: the magenta/checkerboard artifact class ---
    chroma = rgb.max(-1) - rgb.min(-1)
    magenta = (rgb[..., 0] > 0.5) & (rgb[..., 2] > 0.5) & (rgb[..., 1] < rgb[..., 0] * 0.6)
    m["extreme_chroma_frac"] = round(float((chroma > 0.75).mean()), 5)
    m["magenta_frac"] = round(float(magenta.mean()), 5)

    m["mean_linear"] = round(float(lin.mean()), 4)
    return m


# gate(name, predicate, message) — every one traces to a real historical defect
def gates(shot, m, perf):
    out = []

    def g(name, ok, detail):
        out.append({"gate": name, "pass": bool(ok), "detail": detail})

    g("single_sun", m["bright_blobs"] <= 1,
      f"{m['bright_blobs']} blobs >0.965 luma (pass1: 3 suns in golden_hour_vista)")

    if shot in DAYLIGHT:
        g("hdr_headroom", m["max_channel"] >= 248,
          f"max channel {m['max_channel']} (pass2: 235 = no highlight headroom)")
        g("has_blacks", m["p01_luma"] < 0.25,
          f"p0.1 luma {m['p01_luma']:.3f} (pass2 storm white-out: 0.317)")
        if "br_gradient" in m:
            g("aerial_perspective_hue", m["br_gradient"] > 0,
              f"B-R near {m['br_near']:+.3f} -> far {m['br_far']:+.3f} "
              f"(delta {m['br_gradient']:+.3f}; pass1 was negative = inverted)")
            g("aerial_perspective_contrast", m["contrast_gradient"] < 0,
              f"local sigma near {m['lstd_near']:.3f} -> far {m['lstd_far']:.3f} "
              f"(must compress with distance)")
    if "green_sat" in m and m["green_px_frac"] > 0.02:
        g("grass_not_emerald", 0.08 <= m["green_sat"] <= 0.34,
          f"green saturation {m['green_sat']:.3f} (target 0.15-0.25; pass1: 0.43)")

    g("anti_aliased", m["silhouette_aa_px"] >= 1.0,
      f"silhouette transition {m['silhouette_aa_px']:.2f}px (pass2: ~0 = hard step)")
    g("no_chroma_artifacts", m["magenta_frac"] < 0.0004,
      f"magenta fraction {m['magenta_frac']:.5f} (pass2: in-world checkerboards)")

    if perf:
        src = "GPU-synced" if perf.get("gpuSynced") else "CPU-only, UNRELIABLE"
        g("frame_budget", perf["frameMs"] <= 16.7,
          f"{perf['frameMs']:.1f}ms ({1000/max(perf['frameMs'],0.01):.0f}fps, {src}) "
          f"(pass3 regressed all 10 shots over budget)")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", required=True)
    ap.add_argument("--baseline", default=None)
    ap.add_argument("--json", default=None)
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    report_p = os.path.join(a.shots, "report.json")
    perf_by_shot, boot = {}, None
    if os.path.exists(report_p):
        try:
            rep = json.load(open(report_p))
            boot = (rep.get("timings") or {}).get("bootMs")
            for s in rep.get("shots", []):
                st = s["stats"]
                # Prefer the GPU-synced measurement. `frameMs` is CPU submission
                # only and became unreliable once the per-frame pipeline stalls
                # were optimised away — it swings 13-46ms on identical builds.
                perf_by_shot[s["name"]] = {
                    "frameMs": st.get("gpuFrameMs", st["frameMs"]),
                    "gpuSynced": "gpuFrameMs" in st,
                    "drawCalls": st["drawCalls"],
                }
        except Exception:
            pass

    base = {}
    if a.baseline:
        bp = os.path.join(a.baseline, "_metrics.json")
        if os.path.exists(bp):
            base = json.load(open(bp)).get("shots", {})

    results, failures = {}, []
    for f in sorted(os.listdir(a.shots)):
        if not f.endswith(".png") or f.startswith("_"):
            continue
        shot = f[:-4]
        m = analyse(os.path.join(a.shots, f))
        gs = gates(shot, m, perf_by_shot.get(shot))
        results[shot] = {"metrics": m, "gates": gs}
        failures += [(shot, x) for x in gs if not x["pass"]]

    if boot is not None:
        ok = boot <= 5000
        results["_boot"] = {"metrics": {"bootMs": boot},
                            "gates": [{"gate": "boot_budget", "pass": ok,
                                       "detail": f"{boot/1000:.1f}s (budget 5s)"}]}
        if not ok:
            failures.append(("_boot", results["_boot"]["gates"][0]))

    payload = {"shots": results,
               "summary": {"shots": len([k for k in results if not k.startswith('_')]),
                           "failures": len(failures)}}

    out_p = a.json or os.path.join(a.shots, "_metrics.json")
    json.dump(payload, open(out_p, "w"), indent=1)

    if not a.quiet:
        print(f"\n{'SHOT':<22} {'ms':>6} {'B-R grad':>9} {'blobs':>6} {'AA':>5} "
              f"{'p01':>6} {'max':>4}  GATES")
        print("-" * 84)
        for shot, r in results.items():
            if shot.startswith("_"):
                continue
            m, gs = r["metrics"], r["gates"]
            bad = [x for x in gs if not x["pass"]]
            p = perf_by_shot.get(shot, {})
            delta = ""
            if shot in base:
                d = m["mean_luma"] - base[shot]["metrics"]["mean_luma"]
                delta = f"  (luma {d:+.3f})"
            print(f"{shot:<22} {p.get('frameMs',0):>6.1f} "
                  f"{m.get('br_gradient',0):>+9.4f} {m['bright_blobs']:>6} "
                  f"{m['silhouette_aa_px']:>5.2f} {m['p01_luma']:>6.3f} "
                  f"{m['max_channel']:>4}  "
                  f"{'OK' if not bad else ', '.join(x['gate'] for x in bad)}{delta}")
        if boot is not None:
            print(f"\nboot: {boot/1000:.1f}s {'OK' if boot <= 5000 else 'OVER BUDGET (5s)'}")
        if failures:
            print(f"\n{len(failures)} GATE FAILURES:")
            for shot, x in failures:
                print(f"  [{shot}] {x['gate']}: {x['detail']}")
        else:
            print("\nall gates pass")
        print(f"\nwritten: {out_p}")

    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
