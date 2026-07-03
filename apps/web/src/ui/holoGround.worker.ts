// Off-main-thread bake of the holographic map's ground texture. The full city
// tile grid (~46M cells) needs two chamfer distance transforms plus box blurs
// to produce the anti-aliased coastline SDF and land-fabric intensity; doing
// that on the main thread would freeze the game for seconds, so HoloMap ships
// the grid here and gets back the packed RG texture data as a transferable.

interface GroundRequest {
  tiles: Uint8Array;
  width: number;
  height: number;
  /** Intensity per tile kind (indexed by tile kind byte). */
  lut: Uint8Array;
  /** Tile kind byte that counts as water. */
  water: number;
}

/** Two-pass 3-4 chamfer distance transform. Returns, per texel, the distance
 * (in units of 3 per tile) to the nearest set texel. When `feat` is given,
 * the byte value of that nearest texel is propagated along with the distance
 * (used to bleed land intensity across water). */
function chamfer(set: Uint8Array, w: number, h: number, feat?: Uint8Array): Int32Array {
  const INF = 0x3fffffff;
  const d = new Int32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = set[i] ? 0 : INF;
  // Forward sweep: left, up-left, up, up-right.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let best = d[i];
      let from = -1;
      if (x > 0 && d[i - 1] + 3 < best) { best = d[i - 1] + 3; from = i - 1; }
      if (y > 0) {
        if (d[i - w] + 3 < best) { best = d[i - w] + 3; from = i - w; }
        if (x > 0 && d[i - w - 1] + 4 < best) { best = d[i - w - 1] + 4; from = i - w - 1; }
        if (x < w - 1 && d[i - w + 1] + 4 < best) { best = d[i - w + 1] + 4; from = i - w + 1; }
      }
      if (from >= 0) {
        d[i] = best;
        if (feat) feat[i] = feat[from];
      }
    }
  }
  // Backward sweep: right, down-right, down, down-left.
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let best = d[i];
      let from = -1;
      if (x < w - 1 && d[i + 1] + 3 < best) { best = d[i + 1] + 3; from = i + 1; }
      if (y < h - 1) {
        if (d[i + w] + 3 < best) { best = d[i + w] + 3; from = i + w; }
        if (x < w - 1 && d[i + w + 1] + 4 < best) { best = d[i + w + 1] + 4; from = i + w + 1; }
        if (x > 0 && d[i + w - 1] + 4 < best) { best = d[i + w - 1] + 4; from = i + w - 1; }
      }
      if (from >= 0) {
        d[i] = best;
        if (feat) feat[i] = feat[from];
      }
    }
  }
  return d;
}

/** Separable box blur, `passes` iterations (2+ approximates a Gaussian).
 * Edge texels are clamped. Radius is in texels. */
function boxBlur(f: Float32Array, w: number, h: number, r: number, passes: number) {
  const tmp = new Float32Array(f.length);
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    // Horizontal, f -> tmp.
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += f[row + Math.min(Math.max(x, 0), w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc * inv;
        acc += f[row + Math.min(x + r + 1, w - 1)] - f[row + Math.max(x - r, 0)];
      }
    }
    // Vertical, tmp -> f.
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(Math.max(y, 0), h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        f[y * w + x] = acc * inv;
        acc += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
      }
    }
  }
}

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<GroundRequest>) => {
  const { tiles: t, width: w, height: h, lut, water } = e.data;
  const n = w * h;

  const land = new Uint8Array(n);
  const waterMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    land[i] = t[i] === water ? 0 : 1;
    waterMask[i] = land[i] ^ 1;
  }
  // Intensity per tile; the chamfer pass bleeds each water texel's value from
  // its nearest land texel so there's no dark intensity ramp at the coast —
  // the silhouette cut comes purely from the SDF.
  const intensity = new Uint8Array(n);
  for (let i = 0; i < n; i++) intensity[i] = lut[t[i]];
  const distToLand = chamfer(land, w, h, intensity);
  const distToWater = chamfer(waterMask, w, h);

  // Signed distance in tiles (positive inside land), clamped to ±8 tiles,
  // then blurred so the zero contour rounds off the tile staircase instead
  // of tracing it exactly.
  const sdf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const sd = (distToWater[i] - distToLand[i]) / 3;
    sdf[i] = Math.max(-8, Math.min(8, sd));
  }
  boxBlur(sdf, w, h, 2, 2);

  // The interior fabric regions (sidewalk vs building vs park) are stepped
  // tile shapes too; a light blur softens their boundaries the same way.
  const fab = new Float32Array(n);
  for (let i = 0; i < n; i++) fab[i] = intensity[i];
  boxBlur(fab, w, h, 1, 2);

  // RG texture: R = intensity, G = signed distance to the coastline
  // (128 = coast, 16 per tile, positive inside land).
  const data = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    data[i * 2] = fab[i];
    const sd = sdf[i] * 16 + 128;
    data[i * 2 + 1] = sd < 0 ? 0 : sd > 255 ? 255 : sd;
  }
  ctx.postMessage({ data }, [data.buffer]);
};
