// HLOD/city-proxy validation probe: screenshots (street zoom, max zoom-out,
// horizon tilt) plus frame-time percentiles while sprinting across chunk
// boundaries, to catch chunk load/unload hitches.
// Usage: node tools/probe-hlod.mjs [baseUrl]
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
// Let streaming, the proxy partition, and reveal fades settle.
await page.waitForFunction(() => window.__cityProxy, { timeout: 40000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 4000));

// Surface connection drops: a reconnect remounts the whole canvas and will
// dominate any frame-time sample it lands in.
await page.evaluate(() => {
  let was = window.__ui.getState().connected;
  window.__ui.subscribe((s) => {
    if (s.connected !== was) {
      was = s.connected;
      console.info(`probe: connection ${was ? "restored" : "LOST"} at ${Math.round(performance.now())}ms`);
    }
  });
});
page.on("console", (m) => {
  if (m.text().startsWith("probe:")) console.log("[page]", m.text());
});

const shot = async (name) => {
  await page.screenshot({ path: `tools/screens/${name}.png` });
  console.log(`saved tools/screens/${name}.png`);
};

await page.mouse.move(800, 450);
await shot("hlod-street");

// Zoom out to max distance.
for (let i = 0; i < 30; i++) {
  await page.mouse.wheel({ deltaY: 240 });
  await new Promise((r) => setTimeout(r, 40));
}
await new Promise((r) => setTimeout(r, 1500));
await shot("hlod-zoom-out");

// Tilt toward the horizon so the far-field skyline is in frame.
await page.mouse.move(800, 450);
await page.mouse.down({ button: "right" });
for (let i = 0; i < 20; i++) {
  await page.mouse.move(800, 450 - 20 * (i + 1));
  await new Promise((r) => setTimeout(r, 30));
}
await page.mouse.up({ button: "right" });
await new Promise((r) => setTimeout(r, 1500));
await shot("hlod-horizon");

// Back to default-ish zoom for the movement sample.
for (let i = 0; i < 16; i++) {
  await page.mouse.wheel({ deltaY: -240 });
  await new Promise((r) => setTimeout(r, 40));
}
await new Promise((r) => setTimeout(r, 1000));

// Frame-time sampler: rAF deltas + renderer draw calls.
async function sample(label, ms) {
  const out = await page.evaluate(
    (durationMs) =>
      new Promise((resolve) => {
        const deltas = [];
        const calls = [];
        let last = performance.now();
        const start = last;
        function tick() {
          const now = performance.now();
          deltas.push(now - last);
          last = now;
          const gl = window.__wilderGl;
          if (gl) calls.push(gl.gl.info.render.calls);
          if (now - start < durationMs) requestAnimationFrame(tick);
          else resolve({ deltas, calls });
        }
        requestAnimationFrame(tick);
      }),
    ms,
  );
  const d = out.deltas.slice(1).sort((a, b) => a - b);
  const pct = (p) => d[Math.min(d.length - 1, Math.floor((p / 100) * d.length))];
  const over25 = out.deltas.filter((x) => x > 25).length;
  const avgCalls = out.calls.length
    ? Math.round(out.calls.reduce((a, b) => a + b, 0) / out.calls.length)
    : 0;
  console.log(
    label,
    JSON.stringify({
      frames: d.length,
      p50: +pct(50).toFixed(1),
      p95: +pct(95).toFixed(1),
      p99: +pct(99).toFixed(1),
      max: +Math.max(...d).toFixed(1),
      over25ms: over25,
      drawCalls: avgCalls,
    }),
  );
}

// Stationary baseline.
await sample("idle:", 3000);

// Sprint across chunk boundaries: hold shift+W for ~12 s (~60-70 m of travel,
// two boundary crossings each way), sampling the whole run.
await page.keyboard.down("ShiftLeft");
await page.keyboard.down("KeyW");
const run = sample("sprint:", 12000);
await run;
await page.keyboard.up("KeyW");
await new Promise((r) => setTimeout(r, 300));
await page.keyboard.down("KeyS");
const run2 = sample("sprint-back:", 12000);
await run2;
await page.keyboard.up("KeyS");
await page.keyboard.up("ShiftLeft");

// Max zoom steady state (proxy cells in view).
for (let i = 0; i < 30; i++) {
  await page.mouse.wheel({ deltaY: 240 });
  await new Promise((r) => setTimeout(r, 40));
}
await new Promise((r) => setTimeout(r, 1000));
await sample("zoomed-out idle:", 3000);

await browser.close();
