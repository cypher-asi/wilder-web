// Asset Lab dev server (separate from the game gateway).
//   GET  /lab/assets            registry (all assets + statuses + metadata)
//   GET  /lab/jobs              in-flight/finished pipeline jobs
//   POST /lab/import/:id        run Blender import worker for one asset
//   POST /lab/optimize/:id      run game-ready pipeline (body = recipe overrides)
//   POST /lab/promote/:id       copy game-ready GLB into assets/ + manifest
//   GET  /lab/presets           recipe category presets
//   /content/*                  static imported/gameready files (thumbs, GLBs)
//
// Start with: npm run lab   (Vite proxies /lab and /content to :8090)
import express from "express";
import { CONTENT_DIR } from "./paths.mjs";
import { importAsset } from "./import.mjs";
import { optimizeAsset } from "./optimize.mjs";
import { promoteAsset } from "./promote.mjs";
import { CATEGORY_PRESETS } from "./recipes.mjs";
import { loadRegistry } from "./registry.mjs";

const PORT = Number(process.env.ASSET_LAB_PORT ?? 8090);
const app = express();
app.use(express.json());
app.use("/content", express.static(CONTENT_DIR));

/** One pipeline job at a time per asset; UI polls /lab/assets + /lab/jobs. */
const jobs = new Map();

function startJob(assetId, type, work) {
  if (jobs.get(assetId)?.done === false) {
    throw new Error(`A ${jobs.get(assetId).type} job is already running for ${assetId}`);
  }
  const job = { assetId, type, startedAt: new Date().toISOString(), done: false, error: null, result: null };
  jobs.set(assetId, job);
  work()
    .then((result) => {
      job.result = result ?? null;
    })
    .catch((err) => {
      job.error = String(err.message ?? err);
      console.error(`[lab] ${type} ${assetId} failed:`, job.error.split("\n")[0]);
    })
    .finally(() => {
      job.done = true;
      job.finishedAt = new Date().toISOString();
    });
  return job;
}

app.get("/lab/assets", (_req, res) => {
  res.json(loadRegistry());
});

app.get("/lab/presets", (_req, res) => {
  res.json(CATEGORY_PRESETS);
});

app.get("/lab/jobs", (_req, res) => {
  res.json([...jobs.values()]);
});

app.post("/lab/import/:id", (req, res) => {
  try {
    const job = startJob(req.params.id, "import", () => importAsset(req.params.id, { log: () => {} }));
    res.json(job);
  } catch (err) {
    res.status(409).json({ error: String(err.message ?? err) });
  }
});

app.post("/lab/optimize/:id", (req, res) => {
  try {
    const overrides = req.body ?? {};
    const job = startJob(req.params.id, "optimize", () =>
      optimizeAsset(req.params.id, overrides, { log: console.log }),
    );
    res.json(job);
  } catch (err) {
    res.status(409).json({ error: String(err.message ?? err) });
  }
});

app.post("/lab/promote/:id", (req, res) => {
  try {
    res.json(promoteAsset(req.params.id, req.body?.variant ?? null));
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

app.listen(PORT, () => {
  console.log(`[asset-lab] listening on http://localhost:${PORT}`);
});
