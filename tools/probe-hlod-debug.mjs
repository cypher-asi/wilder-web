// Debug probe for the CityProxy layer: cell stats, accurate draw-call counts,
// long-task tracing while sprinting, and a freecam skyline screenshot.
// Usage: node tools/probe-hlod-debug.mjs [baseUrl]
import puppeteer from "puppeteer";

const base = process.argv[2] ?? "http://localhost:5173";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text());
  else if (m.text().includes("proxy")) console.log("[console]", m.text());
});

// Join, retrying the whole login flow if the websocket join stalls. A retry
// may land directly on character select (session resumes from localStorage).
for (let attempt = 1; ; attempt++) {
  try {
    await page.goto(base, { waitUntil: "networkidle2" });
    await page.waitForFunction(
      () =>
        document.querySelector(".char-card") ||
        [...document.querySelectorAll("button")].some((b) =>
          b.textContent.includes("DEV LOGIN"),
        ),
      { timeout: 15000 },
    );
    await page.evaluate(() => {
      const dev = [...document.querySelectorAll("button")].find((b) =>
        b.textContent.includes("DEV LOGIN"),
      );
      if (dev) dev.click();
    });
    await page.waitForSelector(".char-card", { timeout: 15000 });
    await page.click(".char-card");
    await page.waitForSelector("canvas", { timeout: 20000 });
    await page.waitForFunction(() => window.__game && window.__game.localEntityId !== 0, {
      timeout: 20000,
    });
    break;
  } catch (e) {
    if (attempt >= 4) throw e;
    console.log(`join attempt ${attempt} failed (${e.message}), retrying`);
  }
}

// Long-task observer from the start (captures proxy partition cost too).
await page.evaluate(() => {
  window.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
    }
  }).observe({ entryTypes: ["longtask"] });
});

await new Promise((r) => setTimeout(r, 12000));

console.log(
  "parallel compile ext:",
  await page.evaluate(() =>
    Boolean(
      window.__wilderGl.gl.getContext().getExtension("KHR_parallel_shader_compile"),
    ),
  ),
);

await page
  .waitForFunction(() => window.__cityProxy, { timeout: 40000 })
  .catch(() => console.log("proxy build did not finish within 40s"));
const stats = await page.evaluate(() => {
  const p = window.__cityProxy;
  if (!p) return { proxy: "MISSING" };
  let visible = 0;
  for (const c of p.cells) if (c.mesh.visible) visible++;
  return { cells: p.cells.length, visibleCells: visible };
});
console.log("proxy:", JSON.stringify(stats));

// Accurate draw calls: accumulate renderer info over 60 frames.
async function drawCalls(label) {
  const out = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const info = window.__wilderGl.gl.info;
        info.autoReset = false;
        info.reset();
        let frames = 0;
        function tick() {
          frames++;
          if (frames < 60) requestAnimationFrame(tick);
          else {
            const r = { calls: info.render.calls / 60, tris: info.render.triangles / 60 };
            info.autoReset = true;
            resolve(r);
          }
        }
        requestAnimationFrame(tick);
      }),
  );
  console.log(label, JSON.stringify({ calls: Math.round(out.calls), tris: Math.round(out.tris) }));
}
await drawCalls("draws default:");

// Replicate the full probe's pre-sprint sequence (zoom out, tilt, zoom in)
// so any first-seen compiles it triggers land inside the profiled window.
await page.mouse.move(800, 450);
for (let i = 0; i < 30; i++) {
  await page.mouse.wheel({ deltaY: 240 });
  await new Promise((r) => setTimeout(r, 40));
}
await page.mouse.down({ button: "right" });
for (let i = 0; i < 20; i++) {
  await page.mouse.move(800, 450 - 20 * (i + 1));
  await new Promise((r) => setTimeout(r, 30));
}
await page.mouse.up({ button: "right" });
for (let i = 0; i < 16; i++) {
  await page.mouse.wheel({ deltaY: -240 });
  await new Promise((r) => setTimeout(r, 40));
}
await new Promise((r) => setTimeout(r, 1000));

// Sprint for 10 s to cross chunk boundaries, then dump long tasks. CPU
// profile the window so any hitch can be attributed to a call stack.
await page.evaluate(() => (window.__longTasks.length = 0));
const cdp = await page.createCDPSession();
await cdp.send("Profiler.enable");
await cdp.send("Profiler.start");
await page.evaluate(() => {
  window.__rafGaps = [];
  let last = performance.now();
  let lastEntities = window.__game.entities.size;
  let lastRevealed = window.__chunkPipeline.revealed.size;
  function tick() {
    const now = performance.now();
    const entities = window.__game.entities.size;
    const revealed = window.__chunkPipeline.revealed.size;
    if (now - last > 200) {
      window.__rafGaps.push({
        at: Math.round(now),
        gap: Math.round(now - last),
        entitiesBefore: lastEntities,
        entitiesAfter: entities,
        revealedBefore: lastRevealed,
        revealedAfter: revealed,
      });
    }
    last = now;
    lastEntities = entities;
    lastRevealed = revealed;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
});
await page.keyboard.down("ShiftLeft");
await page.keyboard.down("KeyW");
await new Promise((r) => setTimeout(r, 10000));
await page.keyboard.up("KeyW");
await page.keyboard.up("ShiftLeft");
console.log("raf gaps >200ms:", JSON.stringify(await page.evaluate(() => window.__rafGaps)));
const { profile } = await cdp.send("Profiler.stop");
const tasks = await page.evaluate(() => window.__longTasks);
console.log("long tasks during sprint:", JSON.stringify(tasks));

// Aggregate self time per function from the CPU profile.
{
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = profile.timeDeltas ?? [];
  const samples = profile.samples ?? [];
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]);
    if (!node) continue;
    const f = node.callFrame;
    const name = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber}`;
    self.set(name, (self.get(name) ?? 0) + (dt[i] ?? 0));
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log("top self-time during sprint (ms):");
  for (const [name, us] of top) console.log("  ", Math.round(us / 1000), name);
}

// Freecam skyline shot: zoom out first so CameraRig thins the fog to its
// max-zoom value (freecam freezes fog at whatever it was), then pin the
// camera high above the player looking toward the city bulk.
await page.mouse.move(800, 450);
for (let i = 0; i < 30; i++) {
  await page.mouse.wheel({ deltaY: 240 });
  await new Promise((r) => setTimeout(r, 40));
}
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => {
  const me = window.__game.entities.get(window.__game.localEntityId);
  window.__freecam = { pos: [me.x - 60, 90, me.z + 40], look: [me.x + 700, 30, me.z - 300] };
});
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: "tools/screens/hlod-skyline.png" });
console.log("saved tools/screens/hlod-skyline.png");

// Same shot with proxy hidden, to compare what the layer adds.
await page.evaluate(() => {
  window.__cityProxy.group.visible = false;
});
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: "tools/screens/hlod-skyline-off.png" });
console.log("saved tools/screens/hlod-skyline-off.png");

await browser.close();
