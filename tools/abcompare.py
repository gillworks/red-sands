#!/usr/bin/env python3
"""
Blind A/B comparison rig.

Pairs one of our captures with a matched reference frame and emits:
  1. a side-by-side full-frame composite, labelled A | B, with the left/right
     assignment chosen by a per-pair hash so it is deterministic but not
     guessable from the filename;
  2. 1:1 pixel crops of matched semantic regions (foreground ground, midground
     mass, distant ridge, sky) stacked A over B — this is the instrument that
     actually isolates material and detail quality from composition;
  3. key.json recording which side was which, written to a SEPARATE directory
     so a reviewing agent reading the image directory cannot trivially find it.

Reference frames are the publisher's own promotional screenshots, kept outside
the project repo and used transiently as critique reference only.

  python3 tools/abcompare.py --ours shots/pass3 --ref <refdir> --out <outdir>
"""
import argparse, hashlib, json, os
from PIL import Image, ImageDraw

# our shot -> reference file. All references are IN-GAME GAMEPLAY captures (not
# marketing renders), matched to our shot for time of day, subject and scene
# type, and deliberately chosen HUD-FREE so the UI cannot identify which is which.
PAIRS = {
    "golden_hour_vista":    "gp_29.jpg",   # backlit ridge, low sun, stacked haze layers
    "high_noon_desert":     "gp_30.jpg",   # arid rock country, hard daylight, rider
    "town_street":          "gp_24.jpg",   # town street, lamps, wet cobbles, facades
    "forest_interior":      "gp_15.jpg",   # inside canopy, god rays, undergrowth
    "river_bend":           "gp_25.jpg",   # standing water, bank vegetation
    "night_camp":           "gp_12.jpg",   # night camp, lantern/firelight on figures
    "moonlit_ridge":        "gp_18.jpg",   # moonlit plains, dramatic cloud
    "dawn_mist_valley":     "gp_04.jpg",   # heavy valley mist, low contrast
    "storm_plains":         "gp_10.jpg",   # heavy rain, wind, low visibility
    "player_third_person":  "gp_28.jpg",   # third-person on horseback, mountain vista
}

# fractional (x, y, w, h) boxes sampled at 1:1 from both images
REGIONS = {
    "foreground_ground":  (0.28, 0.76, 0.30, 0.22),
    "midground_mass":     (0.34, 0.46, 0.30, 0.22),
    "distant_edge":       (0.34, 0.30, 0.30, 0.16),
    "sky":                (0.06, 0.05, 0.30, 0.16),
}

LABEL_H = 44


def label_strip(w, text, bg=(16, 16, 16), fg=(235, 235, 235)):
    strip = Image.new("RGB", (w, LABEL_H), bg)
    d = ImageDraw.Draw(strip)
    d.text((14, 13), text, fill=fg)
    return strip


def side_by_side(img_a, img_b, out_path, w=940):
    ims = []
    for im in (img_a, img_b):
        h = int(im.height * (w / im.width))
        ims.append(im.resize((w, h), Image.LANCZOS))
    h = max(i.height for i in ims)
    canvas = Image.new("RGB", (w * 2 + 12, h + LABEL_H), (16, 16, 16))
    for i, (im, tag) in enumerate(zip(ims, ("A", "B"))):
        x = i * (w + 12)
        canvas.paste(label_strip(w, tag), (x, 0))
        canvas.paste(im, (x, LABEL_H))
    canvas.save(out_path, quality=94)


def crop_pair(img_a, img_b, box, out_path, maxw=900):
    outs = []
    for im in (img_a, img_b):
        fx, fy, fw, fh = box
        x, y = int(im.width * fx), int(im.height * fy)
        cw, ch = int(im.width * fw), int(im.height * fh)
        c = im.crop((x, y, min(x + cw, im.width), min(y + ch, im.height)))
        if c.width > maxw:                      # keep 1:1 where possible
            c = c.crop((0, 0, maxw, c.height))
        outs.append(c)
    w = max(c.width for c in outs)
    h = sum(c.height for c in outs) + LABEL_H * 2 + 8
    canvas = Image.new("RGB", (w, h), (16, 16, 16))
    y = 0
    for c, tag in zip(outs, ("A", "B")):
        canvas.paste(label_strip(w, tag), (0, y)); y += LABEL_H
        canvas.paste(c, (0, y)); y += c.height + 8
    canvas.save(out_path, quality=95)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ours", required=True)
    ap.add_argument("--ref", help="reference frame directory (RDR2 gameplay)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--keydir", required=True)
    ap.add_argument("--champion", metavar="PREV_SHOTS_DIR",
                    help="champion-ladder mode: compare against the PREVIOUS pass "
                         "instead of the reference. A pass that loses to its own "
                         "parent on any shot has regressed, and we want that "
                         "caught structurally rather than by a diligent reviewer.")
    a = ap.parse_args()
    if not a.ref and not a.champion:
        ap.error("need --ref or --champion")

    os.makedirs(a.out, exist_ok=True)
    os.makedirs(a.keydir, exist_ok=True)
    key = {}

    for shot, ref in PAIRS.items():
        ours_p = os.path.join(a.ours, shot + ".png")
        other_p = (os.path.join(a.champion, shot + ".png") if a.champion
                   else os.path.join(a.ref, ref))
        if not (os.path.exists(ours_p) and os.path.exists(other_p)):
            print("skip", shot, "(missing input)")
            continue

        ours = Image.open(ours_p).convert("RGB")
        refi = Image.open(other_p).convert("RGB")

        # deterministic but non-obvious side assignment
        salt = "champion" if a.champion else "ref"
        flip = int(hashlib.sha256((shot + salt).encode()).hexdigest(), 16) % 2 == 1
        first, second = (refi, ours) if flip else (ours, refi)
        other_name = "previous_pass" if a.champion else "reference"
        key[shot] = {"A": other_name if flip else "ours",
                     "B": "ours" if flip else other_name,
                     "other_file": os.path.basename(other_p),
                     "mode": "champion" if a.champion else "reference"}

        side_by_side(first, second, os.path.join(a.out, f"{shot}__AB.jpg"))
        for rname, box in REGIONS.items():
            crop_pair(first, second, box,
                      os.path.join(a.out, f"{shot}__crop_{rname}.jpg"))
        # NEVER print the A/B assignment. A judging agent typically runs this
        # tool itself and then reads its own stdout, so printing the mapping
        # here silently destroyed the blind for every such run. The key goes to
        # --keydir and nowhere else.
        print("built", shot)

    with open(os.path.join(a.keydir, "key.json"), "w") as f:
        json.dump(key, f, indent=1)
    print("\nkey written to", os.path.join(a.keydir, "key.json"))


if __name__ == "__main__":
    main()
