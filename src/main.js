import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { PRESETS, detectPreset } from './core/Config.js';

import { ProcTextures } from './materials/ProcTextures.js';
import { TimeOfDay } from './sim/TimeOfDay.js';
import { Weather } from './sim/Weather.js';
import { Terrain } from './world/Terrain.js';
import { Water } from './render/Water.js';
import { Vegetation } from './world/Vegetation.js';
import { Scatter } from './world/Scatter.js';
import { Town } from './world/Town.js';
import { Lighting } from './render/Lighting.js';
import { Sky } from './render/Sky.js';
import { Clouds } from './render/Clouds.js';
import { Particles } from './render/Particles.js';
import { Physics } from './sim/Physics.js';
import { Player } from './player/Player.js';
import { Horse } from './player/Horse.js';
import { Wildlife } from './sim/Wildlife.js';
import { CameraRig } from './player/CameraRig.js';
import { PostFX } from './render/PostFX.js';
import { Audio } from './audio/Audio.js';
import { HUD } from './ui/HUD.js';

const params = new URLSearchParams(location.search);
const CAPTURE = params.get('capture') === '1';
const quality = params.get('quality') && PRESETS[params.get('quality')]
  ? PRESETS[params.get('quality')]
  : detectPreset();

const container = document.getElementById('app');
const engine = new Engine({ container, quality });
const ctx = engine.ctx;

/*
 * Registration order  = per-frame UPDATE order (simulation → transforms → visuals).
 * initOrder           = dependency order for async init().
 */
const S = [
  [new TimeOfDay(ctx),    5],
  [new Weather(ctx),     10],
  [new Physics(ctx),     70],
  [new Player(ctx),      75],
  [new Horse(ctx),       80],
  [new Wildlife(ctx),    85],
  [new CameraRig(ctx),   90],
  [new ProcTextures(ctx), 1],
  [new Terrain(ctx),     20],
  [new Water(ctx),       30],
  [new Vegetation(ctx),  40],
  [new Scatter(ctx),     45],
  [new Town(ctx),        50],
  [new Lighting(ctx),    15],
  [new Sky(ctx),         12],
  [new Clouds(ctx),      13],
  [new Particles(ctx),   60],
  [new PostFX(ctx),      95],
  [new Audio(ctx),       97],
  [new HUD(ctx),         99],
];
for (const [sys, initOrder] of S) engine.add(sys, { initOrder });

/* ---------------------------------------------------------------- boot UI */
const bootEl = document.getElementById('boot');
const barEl = document.getElementById('barfill');
const taskEl = document.getElementById('boottask');
const LABELS = {
  procTextures: 'weaving materials', timeOfDay: 'placing the sun',
  weather: 'stirring the air', terrain: 'raising the land',
  water: 'cutting the rivers', vegetation: 'sowing the grass',
  scatter: 'strewing the stones', town: 'building the town',
  lighting: 'hanging the light', sky: 'painting the sky',
  clouds: 'gathering cloud', particles: 'seeding dust',
  physics: 'setting the rules', player: 'waking the rider',
  horse: 'saddling up', wildlife: 'releasing the herds',
  camera: 'framing the shot', postfx: 'grading the film',
  audio: 'tuning the wind', hud: 'final touches', ready: 'ready',
};

await engine.initAll((p, id) => {
  if (barEl) barEl.style.right = `${Math.round((1 - p) * 100)}%`;
  if (taskEl) taskEl.textContent = LABELS[id] || id;
});

engine.start();

if (!CAPTURE) {
  setTimeout(() => bootEl && bootEl.classList.add('gone'), 400);
  setTimeout(() => bootEl && bootEl.remove(), 1800);
} else if (bootEl) {
  bootEl.remove();
}

/* ------------------------------------------------- headless capture API */
const _v = new THREE.Vector3();

function resolvePoint(spec, fallback) {
  if (Array.isArray(spec)) return _v.fromArray(spec).clone();
  if (typeof spec === 'string') {
    const p = ctx.poi.get(spec);
    if (p) return (p.isVector3 ? p : p.pos).clone();
  }
  return fallback.clone();
}

window.__GAME = {
  get ready() { return engine.ready; },
  engine, ctx, THREE,

  /** Step the simulation deterministically; screenshots are taken after this. */
  renderFrames(n = 60, dt = 1 / 60) {
    engine.stop();
    for (let i = 0; i < n; i++) engine.frame(dt);
    return true;
  },

  /** Put the world into a named, reproducible state for a comparison shot. */
  setupShot(shot) {
    const tod = ctx.systems.get('timeOfDay');
    if (tod && tod.setTime) tod.setTime(shot.tod);
    const w = ctx.systems.get('weather');
    if (w && w.setWeather) w.setWeather(shot.weather, { instant: true });

    const rig = ctx.systems.get('camera');
    const pos = resolvePoint(shot.cam.pos, new THREE.Vector3(0, 80, 200));
    const look = resolvePoint(shot.cam.look, new THREE.Vector3(0, 20, 0));

    // Keep the camera above the ground even if a POI is stale.
    if (ctx.world.ready) {
      const h = ctx.world.getHeight(pos.x, pos.z);
      if (pos.y < h + 1.6) pos.y = h + 1.6;
    }
    if (rig && rig.setFreeCamera) {
      rig.setFreeCamera(pos, look, shot.cam.fov);
    } else {
      engine.camera.position.copy(pos);
      engine.camera.lookAt(look);
      engine.camera.fov = shot.cam.fov || 50;
      engine.camera.updateProjectionMatrix();
    }
    // Move the streaming origin so LOD/streaming resolve around the shot.
    ctx.player.position.copy(pos);
    ctx.emit('teleport', pos);
    return true;
  },

  stats() {
    const info = engine.renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs ? info.programs.length : 0,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      frameMs: engine.frameMs,
      quality: quality.name,
      failedSystems: [...ctx.systems.entries()].filter(([, s]) => s.__failed).map(([k]) => k),
      /** Per-system CPU ms, most expensive first — names the offender when a
       *  frame goes over budget. See Engine.frame() for what this does and
       *  does not measure. */
      systemMs: Object.entries(engine._profile)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([k, v]) => [k, Math.round(v * 100) / 100]),
    };
  },
};

if (import.meta.env && import.meta.env.DEV) {
  console.log('[RED SANDS] booted at quality:', quality.name);
}
