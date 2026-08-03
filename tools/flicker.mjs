/**
 * CAMERA-MOTION FLICKER PROBE  —  the gate the static/dolly pair could not be.
 *
 * WHY THIS EXISTS
 * ---------------
 * `capture.mjs --motion` gives motion.py two sequences: a STATIC camera and a
 * straight DOLLY. A whole class of defect is invisible to both:
 *
 *   - static  : the artifact only exists while the camera moves.
 *   - dolly   : translation alone does not trigger it. Any error that is an
 *               angular misregistration scales with |viewPos| and cancels for a
 *               pure translation on locally planar ground, because the receiver
 *               -plane bias absorbs a constant world offset. You must ROTATE.
 *   - both    : they judge WHOLE-FRAME deltas, so a band that occupies 6% of
 *               the pixels at one camera-relative distance is averaged away.
 *
 * The stale-camera-matrix bug in CascadedShadowMaps (cascades 1-3 were handed a
 * camera-to-world matrix up to 3 frames old, because the composed uniform was
 * only written inside `_fit`, which runs on the 1/2/3/4 redraw stagger) shipped
 * straight past both gates for exactly those three reasons.
 *
 * WHAT THIS MEASURES
 * ------------------
 * Camera walks a fixed world path while PANNING. Every frame we read the real
 * canvas plus TRUE view depth (linearised out of postfx.sceneRT.depthTexture by
 * our own quad) and bin pixels into geometric CAMERA-RELATIVE distance bins.
 * The statistic is a second-difference dark residual on the per-bin mean luma,
 *
 *     r[f][b] = (nm[f-1][b] + nm[f+1][b]) / 2 - nm[f][b]
 *
 * with nm normalised by whole-frame luma. Smooth change (moving through the
 * world, auto-exposure, the sun) is linear in f and cancels exactly; only a
 * one-frame excursion survives. Positive r = the band went DARK for one frame,
 * which is the human-reported symptom.
 *
 *   node tools/flicker.mjs                          gate run, writes _flicker.json
 *   node tools/flicker.mjs --variants fixed,stale   A/B a hypothesis
 *   node tools/flicker.mjs --site desert --steps 90 --yawrate 1.0
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function arg(name, dflt = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

/**
 * Probe sites. Each is a start position + heading over ground the report is
 * about (open terrain with rock, so "the ground and rocks" are what is binned).
 */
export const SITES = {
  desert:  { x0: 700,  z0: 240,  yaw: 0.49, pitch: -0.10, eye: 3, tod: 12.4, fov: 52 },
  golden:  { x0: -420, z0: 610,  yaw: 2.55, pitch: -0.08, eye: 3, tod: 18.15, fov: 52 },
};

/**
 * GATE MODE. Two variants on two sites:
 *   shipped     — the build exactly as it is
 *   shadowsOff  — same path, cascade lookup disabled (rsCsmParams.w = 0)
 * `shadowsOff` is the CONTENT FLOOR. Comparing against a floor measured on the
 * same path in the same run is what makes the gate content-independent: it does
 * not care how much a site's foliage or terrain shimmers, only whether the
 * shadow system ADDS a camera-motion dark band on top of it.
 */
const GATE = !!arg('gate');

const STEPS = parseInt(arg('steps', GATE ? '90' : '96'), 10);
const SPEED = parseFloat(arg('speed', '0.25'));      // m/frame, ~15 m/s gallop
const YAWRATE = parseFloat(arg('yawrate', '1.0'));   // deg/frame = 60 deg/s @60fps
const SETTLE = parseInt(arg('settle', '70'), 10);
const W = parseInt(arg('w', '960'), 10);
const H = parseInt(arg('h', '540'), 10);
const QUALITY = arg('quality', 'high');
const REPEAT = parseInt(arg('repeat', '1'), 10);
const VARIANTS = String(arg('variants', GATE ? 'shipped,shadowsOff' : 'shipped'))
  .split(',').map((s) => s.trim()).filter(Boolean);
const SITE_LIST = String(arg('site', 'desert,golden')).split(',').map((s) => s.trim()).filter((s) => SITES[s]);
const OUT = arg('out', null);
/**
 * GATE NEGATIVE CONTROL. Runs `--emulate <variant>` but records it under the
 * name `shipped`, so the gate in tools/motion.py can be pointed at a build it
 * MUST fail. `--gate --emulate stale` reinstates the pre-fix
 * CascadedShadowMaps behaviour (composed uniform written only inside `_fit`)
 * and is the run that proves the gate is not vacuous.
 */
const EMULATE = arg('emulate', null);

/* ------------------------------------------------------------------ analysis */

/**
 * Second-difference dark residual per distance bin, x1000.
 * rows[f].mean[b] is the bin's mean luma, rows[f].frameMean the whole frame's.
 */
export function analyse(rows, minPix = 120) {
  const NB = rows[0].mean.length;
  const out = [];
  for (let b = 0; b < NB; b++) {
    let sum = 0, n = 0, peak = 0;
    const series = [];
    for (let f = 1; f < rows.length - 1; f++) {
      const a = rows[f - 1], c = rows[f], d = rows[f + 1];
      if (!(a.cnt[b] > minPix && c.cnt[b] > minPix && d.cnt[b] > minPix)) { series.push(0); continue; }
      const na = a.mean[b] / a.frameMean;
      const nc = c.mean[b] / c.frameMean;
      const nd = d.mean[b] / d.frameMean;
      const r = ((na + nd) * 0.5 - nc) * 1000;
      series.push(r);
      if (r > 0) { sum += r; n++; }
      if (r > peak) peak = r;
    }
    // Mean over ALL frames of the positive part: a band that spikes dark on one
    // frame in three must not be flattered by averaging only its spikes.
    const dark = series.length ? series.reduce((s, r) => s + Math.max(r, 0), 0) / series.length : 0;
    out.push({ dark, peak, n, series });
  }
  return out;
}

/** Autocorrelation of a residual series at a given lag — the stagger signature. */
export function autocorr(series, lag) {
  const n = series.length;
  if (n - lag < 8) return 0;
  let m = 0;
  for (const v of series) m += v;
  m /= n;
  let num = 0, den = 0;
  for (let i = 0; i < n - lag; i++) num += (series[i] - m) * (series[i + lag] - m);
  for (const v of series) den += (v - m) * (v - m);
  return den > 0 ? (num / den) * (n / (n - lag)) : 0;
}

/* ---------------------------------------------------------------- page rig */

async function installRig(page) {
  await page.evaluate(() => {
    const g = window.__GAME, T = g.THREE;
    const R = {};
    window.__RIG = R;

    R.renderer = g.engine.renderer;
    R.camera = g.engine.camera;
    R.lighting = g.ctx.systems.get('lighting');
    R.csm = R.lighting && R.lighting.csm;
    R.postfx = g.ctx.systems.get('postfx');

    // ---- linearising depth pass (TRUE camera-relative distance) -------------
    R.GW = 320; R.GH = 180;
    R.depthRT = new T.WebGLRenderTarget(R.GW, R.GH, {
      format: T.RGBAFormat, type: T.UnsignedByteType,
      minFilter: T.NearestFilter, magFilter: T.NearestFilter, depthBuffer: false,
    });
    R.quadMat = new T.ShaderMaterial({
      uniforms: { tDepth: { value: null }, uNF: { value: new T.Vector2(0.15, 12000) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }',
      fragmentShader: `
        precision highp float;
        uniform sampler2D tDepth; uniform vec2 uNF; varying vec2 vUv;
        void main(){
          float d = texture2D(tDepth, vUv).x;
          float near = uNF.x, far = uNF.y;
          float viewZ = (near*far)/((far-near)*d - far);
          float dist = -viewZ;
          float v = clamp(dist/2048.0, 0.0, 1.0);
          vec2 e = fract(vec2(1.0, 255.0) * v);
          e.x -= e.y/255.0;
          gl_FragColor = vec4(e, 0.0, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    const quad = new T.Mesh(new T.PlaneGeometry(2, 2), R.quadMat);
    quad.frustumCulled = false;
    R.quadScene = new T.Scene(); R.quadScene.add(quad);
    R.quadCam = new T.Camera();
    R.depthPix = new Uint8Array(R.GW * R.GH * 4);

    R.cv = document.createElement('canvas');
    R.cv.width = R.GW; R.cv.height = R.GH;
    R.c2 = R.cv.getContext('2d', { willReadFrequently: true });

    // ---- geometric distance bins, 2 m .. 640 m ------------------------------
    R.NB = 28;
    R.edges = [];
    for (let k = 0; k <= R.NB; k++) R.edges.push(2 * Math.pow(320, k / R.NB));
    R.binOf = (d) => {
      if (!(d > 2) || d >= 640) return -1;
      return Math.min(R.NB - 1, Math.floor(Math.log(d / 2) / Math.log(320) * R.NB));
    };

    // ---- variants ------------------------------------------------------------
    const c = R.csm;
    if (c) {
      c.__origUpdate = c.update.bind(c);
      c.__origFit = c._fit.bind(c);
      c.__origRefresh = c._refreshMatrices.bind(c);
    }
    R.hidden = [];
    R.applyVariant = (name) => {
      // reset everything first
      for (const o of R.hidden) o.visible = true;
      R.hidden.length = 0;
      if (c) {
        c.update = c.__origUpdate;
        c._fit = c.__origFit;
        c._refreshMatrices = c.__origRefresh;
      }
      if (R.postfx) {
        if (R.__ssr === undefined) R.__ssr = R.postfx.useSSR;
        R.postfx.useSSR = R.__ssr;
        if (R.__taa === undefined) R.__taa = R.postfx.useTAA;
        R.postfx.useTAA = R.__taa;
      }
      const hide = (pred) => {
        g.ctx.scene.traverse((o) => {
          if (o.visible && pred(o)) { o.visible = false; R.hidden.push(o); }
        });
      };

      if (name === 'shipped' || name === 'fixed') {
        /* source exactly as it is */
      } else if (name === 'stale' && c) {
        /*
         * Emulates the PRE-FIX CascadedShadowMaps exactly: the composed
         * view-space -> cascade-clip uniform is written ONLY inside `_fit`, so a
         * cascade that is not refitted this frame keeps a camera matrix from up
         * to 3 frames ago. This is the "before" number.
         */
        c._refreshMatrices = () => {};
        c._fit = (i, camera) => {
          c.__origFit(i, camera);
          c.uniforms.rsCsmMat.value[i].multiplyMatrices(c._lightVP[i], camera.matrixWorld);
        };
      } else if (name === 'shadowsOff' && c) {
        c.update = (dt, camera, dir) => { c.__origUpdate(dt, camera, dir); c.uniforms.rsCsmParams.value.w = 0; };
      } else if (name === 'forceAll' && c) {
        c.update = (dt, camera, dir) => { c._forceFrames = 2; c.__origUpdate(dt, camera, dir); };
      } else if (name === 'ssrOff' && R.postfx) {
        R.postfx.useSSR = false;
      } else if (name === 'vegOff') {
        hide((o) => /grass|undergrowth|vegetation|scatter|forest/i.test(o.name || ''));
      } else if (name === 'grassOff') {
        hide((o) => /grass/i.test(o.name || ''));
      } else if (name === 'scatterOff') {
        hide((o) => /^scatter/i.test(o.name || ''));
      } else if (name === 'treesOff') {
        hide((o) => /^vegetation$|impostor/i.test(o.name || ''));
      } else if (name === 'taaOff' && R.postfx) {
        if (R.__taa === undefined) R.__taa = R.postfx.useTAA;
        R.postfx.useTAA = false;
      }
      R.variant = name;
    };

    // ---- camera path ---------------------------------------------------------
    R.setPose = (k, p) => {
      const yaw = p.yaw + (p.yawRate || 0) * k;
      const dx = Math.cos(yaw), dz = Math.sin(yaw);
      // translate along the ORIGINAL heading so pan and dolly stay independent
      const hx = Math.cos(p.yaw), hz = Math.sin(p.yaw);
      const x = p.x0 + hx * p.speed * k;
      const z = p.z0 + hz * p.speed * k;
      const h = g.ctx.world.ready ? g.ctx.world.getHeight(x, z) : 0;
      const pos = new T.Vector3(x, h + p.eye, z);
      const look = new T.Vector3(x + dx * 120, h + p.eye + Math.tan(p.pitch) * 120, z + dz * 120);
      const rig = g.ctx.systems.get('camera');
      rig.setFreeCamera(pos, look, p.fov);
      g.ctx.player.position.copy(pos);
    };

    R.sample = () => {
      const rr = R.renderer;
      const prev = rr.getRenderTarget();
      R.quadMat.uniforms.tDepth.value = R.postfx.sceneRT.depthTexture;
      R.quadMat.uniforms.uNF.value.set(R.camera.near, R.camera.far);
      rr.setRenderTarget(R.depthRT);
      rr.render(R.quadScene, R.quadCam);
      rr.readRenderTargetPixels(R.depthRT, 0, 0, R.GW, R.GH, R.depthPix);
      rr.setRenderTarget(prev);

      R.c2.drawImage(rr.domElement, 0, 0, R.GW, R.GH);
      const img = R.c2.getImageData(0, 0, R.GW, R.GH).data;

      const sum = new Float64Array(R.NB);
      const cnt = new Float64Array(R.NB);
      let all = 0, alln = 0;
      const GW = R.GW, GH = R.GH;
      for (let y = 0; y < GH; y++) {
        const dy = GH - 1 - y;             // depth RT is bottom-up
        for (let x = 0; x < GW; x++) {
          const di = (dy * GW + x) * 4;
          const d = ((R.depthPix[di] + R.depthPix[di + 1] / 255) / 255) * 2048;
          const b = R.binOf(d);
          if (b < 0) continue;
          const ci = (y * GW + x) * 4;
          const L = 0.2126 * img[ci] + 0.7152 * img[ci + 1] + 0.0722 * img[ci + 2];
          sum[b] += L; cnt[b]++;
          all += L; alln++;
        }
      }
      const mean = new Array(R.NB);
      for (let b = 0; b < R.NB; b++) mean[b] = cnt[b] > 0 ? sum[b] / cnt[b] : NaN;
      return { mean, cnt: Array.from(cnt), frameMean: alln ? all / alln : 0 };
    };

    R.run = (variant, p, steps, settle) => {
      const tod = g.ctx.systems.get('timeOfDay');
      if (tod && tod.setTime) tod.setTime(p.tod);
      const w = g.ctx.systems.get('weather');
      if (w && w.setWeather) w.setWeather('clear', { instant: true });
      R.applyVariant(variant);
      R.setPose(0, p);
      g.ctx.emit('teleport', R.camera.position.clone());
      if (R.csm) R.csm.invalidate();
      g.renderFrames(settle);        // TAA history, auto-exposure, streaming

      const rows = [];
      for (let k = 0; k < steps; k++) {
        R.setPose(k, p);
        g.renderFrames(1);
        rows.push(R.sample());
      }
      const splits = R.csm ? Array.from(R.csm.uniforms.rsCsmSplits.value.toArray()) : [];
      return { rows, splits, edges: R.edges };
    };
    return true;
  });
}

/* ---------------------------------------------------------------------- main */

async function main() {
  const server = await createServer({
    root: ROOT, logLevel: 'error',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
      '--disable-frame-rate-limit', '--disable-gpu-vsync'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${url}/?quality=${QUALITY}&capture=1`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__GAME && window.__GAME.ready === true,
    null, { timeout: 240000, polling: 250 });
  await installRig(page);

  const out = {
    params: { steps: STEPS, speed: SPEED, yawDegPerFrame: YAWRATE, settle: SETTLE, quality: QUALITY, W, H },
    sites: {}, errors,
  };

  for (const site of SITE_LIST) {
    const p = { ...SITES[site], speed: SPEED, yawRate: YAWRATE * Math.PI / 180 };
    out.sites[site] = { params: p, variants: {} };
    for (let rep = 0; rep < REPEAT; rep++) {
      for (const v of VARIANTS) {
        const t0 = Date.now();
        const run = (EMULATE && (v === 'shipped' || v === 'fixed')) ? EMULATE : v;
        const r = await page.evaluate(
          ({ run, p, STEPS, SETTLE }) => window.__RIG.run(run, p, STEPS, SETTLE),
          { run, p, STEPS, SETTLE });
        const bins = analyse(r.rows);
        const rec = {
          edges: r.edges, splits: r.splits,
          dark: bins.map((b) => +b.dark.toFixed(3)),
          peak: bins.map((b) => +b.peak.toFixed(3)),
          /*
           * Autocorrelation of each bin's residual series at the cascade
           * refresh intervals (1/2/3/4 frames by cascade index). This is the
           * mechanism-specific half of the gate: a band that flickers at
           * exactly its own cascade's stagger period cannot be content noise.
           * The stale-matrix bug measured +0.98 at lag 3 in cascade 2's band;
           * the repaired build measures +0.43 there, which is the same number
           * shadows-off measures.
           */
          ac: bins.map((b) => [2, 3, 4].map((L) => +autocorr(b.series, L).toFixed(3))),
          series: bins.map((b) => b.series.map((x) => +x.toFixed(3))),
          pix: r.rows[Math.floor(r.rows.length / 2)].cnt,
        };
        if (!out.sites[site].variants[v]) out.sites[site].variants[v] = [];
        out.sites[site].variants[v].push(rec);
        process.stdout.write(`  ${site}/${v}${run !== v ? ` (as ${run})` : ""} rep${rep}  ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
      }
    }
  }

  const file = OUT ? path.resolve(ROOT, OUT) : path.join(ROOT, 'tools', '_flicker.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(out));
  console.log('wrote ' + file);
  if (errors.length) console.log('PAGE ERRORS: ' + errors.slice(0, 5).join(' | '));

  await browser.close();
  await server.close();
}

if (import.meta.url === `file://${process.argv[1]}`) main();
