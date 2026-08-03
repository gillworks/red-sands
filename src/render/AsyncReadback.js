/**
 * Non-blocking GPU→CPU readback through a WebGL2 pixel-pack-buffer ring.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two systems need a handful of pixels back on the CPU every frame: PostFX
 * reads its 1x1 auto-exposure result, and Sky reads a 48x32 probe of the
 * sky-view LUT to drive ambient/fog colour. Both were doing it with
 * `renderer.readRenderTargetPixels`, which is a **synchronous** `glReadPixels`
 * — it blocks the CPU until the GPU has finished everything queued ahead of it.
 * That is a full pipeline drain, and with one in Sky.update and another in
 * PostFX.render there were two per frame, so CPU and GPU could never overlap:
 * the frame cost became CPU + GPU instead of max(CPU, GPU).
 *
 * `readRenderTargetPixelsAsync` is not a fix here. It resolves on a promise,
 * and the screenshot harness advances the world inside ONE synchronous
 * `renderFrames()` call, so no promise ever settles during a capture — Sky
 * detects the starvation after 40 frames and falls back to the blocking read,
 * which is exactly the path every measurement runs on.
 *
 * A PBO ring needs no promises. `glReadPixels` into a bound PIXEL_PACK_BUFFER
 * returns immediately (it only schedules the copy); `getBufferSubData` on a
 * buffer whose read was issued N frames ago finds the data already there. The
 * cost is N frames of latency on a value that drives auto-exposure adaptation
 * and ambient colour — both of which are smoothed over hundreds of milliseconds
 * anyway — and it is deterministic, because the latency is counted in frames
 * rather than in wall-clock time.
 */

export class PixelRing {
  /**
   * @param {import('three').WebGLRenderer} renderer
   * @param {{width:number, height:number, array:ArrayBufferView,
   *          glFormat:number, glType:number, latency?:number}} o
   */
  constructor(renderer, o) {
    this.renderer = renderer;
    const gl = renderer.getContext();
    this.gl = gl;
    this.w = o.width;
    this.h = o.height;
    this.dst = o.array;
    this.format = o.glFormat;
    this.type = o.glType;
    this.idx = 0;
    /** True once `dst` has been filled at least once. */
    this.ready = false;
    /** Cleared if anything at all goes wrong; callers fall back to a sync read. */
    this.ok = !!(gl && typeof gl.getBufferSubData === 'function' && gl.PIXEL_PACK_BUFFER);

    const n = Math.max(2, o.latency || 3);
    this.bufs = [];
    this.age = new Int32Array(n).fill(-1);
    if (!this.ok) return;
    try {
      for (let i = 0; i < n; i++) {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, this.dst.byteLength, gl.STREAM_READ);
        this.bufs.push(b);
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    } catch (e) {
      this.ok = false;
    }
  }

  /**
   * Resolve the read issued `latency` frames ago into `this.dst`, then issue a
   * fresh one. Never blocks in steady state.
   * @returns {boolean} true when `dst` was refreshed this call
   */
  pump(rt, x = 0, y = 0) {
    if (!this.ok) return false;
    const gl = this.gl;
    const slot = this.idx % this.bufs.length;
    let got = false;

    if (this.age[slot] >= 0) {
      try {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.bufs[slot]);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.dst);
        got = true;
        this.ready = true;
      } catch (e) {
        this.ok = false;
      }
    }

    if (this.ok) {
      const prev = this.renderer.getRenderTarget();
      try {
        this.renderer.setRenderTarget(rt);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.bufs[slot]);
        gl.readPixels(x, y, this.w, this.h, this.format, this.type, 0);
        this.age[slot] = this.idx;
      } catch (e) {
        this.ok = false;
        this.age[slot] = -1;
      }
      try { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); } catch (e) { /* context lost */ }
      this.renderer.setRenderTarget(prev);
    }

    this.idx++;
    return got;
  }

  dispose() {
    if (!this.gl) return;
    for (const b of this.bufs) {
      try { this.gl.deleteBuffer(b); } catch (e) { /* context lost */ }
    }
    this.bufs.length = 0;
    this.ok = false;
  }
}
