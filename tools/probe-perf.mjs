// Measure in-game frame rate per visual style (dev only).
//
//   node tools/probe-perf.mjs [--url http://localhost:5173] [--styles tron,golden]
//
// For each style: fresh page with `wilder.visualStyle` pre-seeded, dev login,
// spawn, settle, then sample FPS over a fixed window. Prints one line per style
// plus renderer stats when the perf registry is available (window.__perf).
import puppeteer from "puppeteer";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const URL = argOf("url", "http://localhost:5173");
const STYLES = argOf("styles", "golden,blueHour,animeDusk,animeSunset,tron").split(",");
const SETTLE_MS = Number(argOf("settle", "12000"));
const SAMPLE_MS = Number(argOf("sample", "6000"));
const DPR = Number(argOf("dpr", "1"));
/** Character card index on the select screen (a card can be rejected with
 * "character already in world" if another session holds it). */
const CHAR = Number(argOf("char", "1"));

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--window-size=1600,900",
    "--use-gl=angle",
    // Uncap rAF from the display refresh so fps reflects true throughput
    // rather than pegging at 60 for every style.
    "--disable-frame-rate-limit",
    "--disable-gpu-vsync",
  ],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: DPR },
});

const results = [];
for (const style of STYLES) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((s) => {
    localStorage.setItem("wilder.visualStyle", s);
  }, style);
  try {
    await page.goto(URL, { waitUntil: "networkidle2" });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("button")].some((b) =>
          b.textContent.includes("DEV LOGIN"),
        ),
      { timeout: 15000 },
    );
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent.includes("DEV LOGIN"))
        .click();
    });
    await page.waitForSelector(".char-card", { timeout: 15000 });
    await page.evaluate((idx) => {
      [...document.querySelectorAll(".char-card")][idx].click();
    }, CHAR);
    await page.waitForSelector("canvas", { timeout: 20000 });
    // The canvas mounts before the world join completes; wait for the actual
    // join so measurements include streamed chunks and entities.
    await page.waitForFunction(() => window.__ui?.getState?.().joined === true, {
      timeout: 20000,
    });
    // Turn on section timing so snapshot() includes per-system CPU costs.
    await page.evaluate(() => {
      if (window.__perf) window.__perf.enabled = true;
    });
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const stats = await page.evaluate(
      (sampleMs) =>
        new Promise((resolve) => {
          const times = [];
          let last = performance.now();
          const start = last;
          const tick = () => {
            const now = performance.now();
            times.push(now - last);
            last = now;
            if (now - start < sampleMs) {
              requestAnimationFrame(tick);
              return;
            }
            times.sort((a, b) => a - b);
            const sum = times.reduce((a, b) => a + b, 0);
            const avg = sum / times.length;
            const p95 = times[Math.floor(times.length * 0.95)];
            const perf = window.__perf?.snapshot?.();
            resolve({
              fps: 1000 / avg,
              avgMs: avg,
              p95Ms: p95,
              frames: times.length,
              drawCalls: perf?.drawCalls,
              triangles: perf?.triangles,
              sections: perf?.sections?.slice(0, 8),
            });
          };
          requestAnimationFrame(tick);
        }),
      SAMPLE_MS,
    );
    results.push({ style, ...stats });
    const extra =
      stats.drawCalls != null
        ? `  draws ${stats.drawCalls}  tris ${(stats.triangles / 1e6).toFixed(2)}M`
        : "";
    console.log(
      `${style.padEnd(12)} fps ${stats.fps.toFixed(1).padStart(6)}  avg ${stats.avgMs.toFixed(2)}ms  p95 ${stats.p95Ms.toFixed(2)}ms${extra}`,
    );
    if (stats.sections?.length) {
      const parts = stats.sections
        .map((s) => `${s.name} ${s.avgMs.toFixed(2)}`)
        .join("  ");
      console.log(`             cpu: ${parts}`);
    }
  } catch (err) {
    console.log(`${style.padEnd(12)} FAILED: ${err.message}`);
    results.push({ style, error: err.message });
  } finally {
    await page.close();
  }
}

await browser.close();
