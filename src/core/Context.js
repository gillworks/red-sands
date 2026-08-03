import * as THREE from 'three';

/**
 * ============================================================================
 *  FROZEN CONTRACT — shared context passed to every system.
 *  Systems READ what they need and WRITE only fields they own.
 *  Do not rename or remove fields. Additive changes only.
 * ============================================================================
 *
 * System lifecycle (all optional except update):
 *    class MySystem {
 *      static id = 'mySystem';        // key under which it registers
 *      constructor(ctx) {}
 *      async init() {}                // heavy setup; may report progress
 *      update(dt) {}                  // per frame, before render
 *      lateUpdate(dt) {}              // after cameras/transforms settled
 *      resize(w, h) {}
 *      dispose() {}
 *    }
 */

/** Environment state. OWNED BY: TimeOfDay (solar/lunar), Weather (atmosphere). */
export function createEnv() {
  return {
    // --- solar / lunar (owned by TimeOfDay) ---
    /** Normalised direction FROM the world TO the sun. */
    sunDirection: new THREE.Vector3(0.4, 0.7, 0.3).normalize(),
    /** Linear HDR radiance colour of the sun disc. */
    sunColor: new THREE.Color(1, 0.96, 0.9),
    /** Sun irradiance multiplier; 0 when below horizon. */
    sunIntensity: 3.0,
    moonDirection: new THREE.Vector3(-0.4, -0.7, -0.3).normalize(),
    moonColor: new THREE.Color(0.55, 0.68, 0.95),
    moonIntensity: 0.0,
    /** Moon phase, 0 = new, 0.5 = full, 1 = new. */
    moonPhase: 0.5,
    /** Hours, 0..24 (fractional). */
    timeOfDay: 9.0,
    /** Day of year, 0..365 — drives solar declination. */
    dayOfYear: 172,
    /** 0 at night, 1 at full day — smooth. */
    daylight: 1.0,
    /** -1..1, peaks at ±1 during the two twilights. */
    twilight: 0.0,

    // --- atmosphere / weather (owned by Weather) ---
    /** Ambient sky irradiance (linear). */
    ambientColor: new THREE.Color(0.35, 0.45, 0.6),
    ambientIntensity: 0.6,
    /** Aerosol turbidity for scattering, 1.8 (crystal) .. 12 (dust storm). */
    turbidity: 2.6,
    /** Distance fog. */
    fogColor: new THREE.Color(0.62, 0.68, 0.78),
    fogDensity: 0.00016,
    /** Ground-hugging mist amount 0..1. */
    groundMist: 0.0,
    /** 0..1 cloud coverage driving the volumetric cloud layer. */
    cloudCover: 0.35,
    /** 0..1 how vertically developed / dark the clouds are. */
    cloudDensity: 0.4,
    /** 0..1 how wet surfaces are; drives roughness + puddles. */
    wetness: 0.0,
    /** 0..1 precipitation rates. */
    rainIntensity: 0.0,
    snowIntensity: 0.0,
    /** 0..1 snow accumulated on the ground. */
    snowCover: 0.0,
    /** Short bright spike, 0..1, set for a few frames by storms. */
    lightningFlash: 0.0,
    /** Named state for debug/UI: 'clear' | 'fair' | 'overcast' | 'rain' | 'storm' | 'fog' | 'snow' | 'dust'. */
    weatherName: 'clear',

    // --- wind (owned by Weather) ---
    /** Horizontal wind direction & speed, m/s, y unused. */
    windVector: new THREE.Vector3(1, 0, 0.3).normalize().multiplyScalar(3),
    windStrength: 3.0,
    /** 0..1 gust envelope, updated per frame. */
    windGust: 0.0,

    // --- camera/exposure (owned by PostFX auto-exposure) ---
    exposure: 1.0,
    /** True when the camera is under water. Owned by Water. */
    cameraSubmerged: false,
  };
}

/**
 * World queries. OWNED BY: Terrain — it replaces these with real implementations
 * during init(). Everything else may call them from init() onward.
 */
export function createWorld() {
  return {
    /** Terrain surface height in metres at world (x,z). */
    getHeight: (_x, _z) => 0,
    /** Unit surface normal at world (x,z). */
    getNormal: (_x, _z, target = new THREE.Vector3()) => target.set(0, 1, 0),
    /**
     * Surface composition at (x,z), weights sum ~1.
     * @returns {{grass:number,rock:number,dirt:number,sand:number,snow:number}}
     */
    getSurface: (_x, _z) => ({ grass: 1, rock: 0, dirt: 0, sand: 0, snow: 0 }),
    /** Global still-water plane height. */
    waterLevel: 18,
    /** True if (x,z) is inside a river/lake polygon. */
    isWater: (_x, _z) => false,
    /** 0..1 — how walkable/steep. 1 = flat. */
    getSlope: (_x, _z) => 1,
    /** Half-extent of the playable square. */
    size: 8192,
    /** True once the heightfield is queryable. */
    ready: false,
  };
}

export function createContext({ renderer, scene, camera, canvas, quality }) {
  const ctx = {
    THREE,
    renderer,
    scene,
    camera,
    canvas,
    quality,

    /** Frame timing. Owned by Engine. */
    time: { elapsed: 0, dt: 0, frame: 0, /** unclamped wall dt */ rawDt: 0 },

    env: createEnv(),
    world: createWorld(),

    /**
     * Player state. OWNED BY: Player.
     * Other systems read position/velocity for LOD + streaming.
     */
    player: {
      position: new THREE.Vector3(0, 0, 0),
      velocity: new THREE.Vector3(),
      /** Facing yaw in radians. */
      yaw: 0,
      /** 'onFoot' | 'mounted' | 'swimming' */
      mode: 'onFoot',
      /** 0..1 how fast relative to sprint. */
      speed01: 0,
      /** Reference to the horse object when mounted, else null. */
      horse: null,
      /** True while the player is inside a settlement volume. */
      inTown: false,
    },

    /** Registered systems, keyed by `static id`. */
    systems: new Map(),

    /**
     * Named points of interest for the screenshot harness and fast travel.
     * Systems SHOULD register their showpiece locations during init():
     *   ctx.poi.set('town', { pos: new THREE.Vector3(...), look: new THREE.Vector3(...) })
     * Expected keys: town, town_end, camp, camp_fire, river, river_down,
     *                forest, forest_fwd.
     */
    poi: new Map(),

    /** Simple pub/sub. */
    _listeners: new Map(),
    on(evt, fn) {
      if (!ctx._listeners.has(evt)) ctx._listeners.set(evt, new Set());
      ctx._listeners.get(evt).add(fn);
      return () => ctx._listeners.get(evt).delete(fn);
    },
    emit(evt, payload) {
      const s = ctx._listeners.get(evt);
      if (s) for (const fn of s) fn(payload);
    },

    /** Fetch another system by id; returns undefined if not present. */
    get(id) {
      return ctx.systems.get(id);
    },

    /** Deterministic PRNG shared by all procedural generation. */
    seed: 20261031,
  };
  return ctx;
}

/**
 * Small, fast, seedable PRNG (mulberry32). Use this everywhere instead of
 * Math.random() so worlds are reproducible across agents and screenshots.
 */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
