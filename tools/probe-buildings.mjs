// Temporary: dump streamed building instances near a world position so shot
// scripts can pick unobstructed vantage points. Dev-only (__game handle).
import puppeteer from "puppeteer";

const PORT = process.env.PORT ?? "5199";
const CX = Number(process.env.CX ?? 36);
const CZ = Number(process.env.CZ ?? 60);
const R = Number(process.env.R ?? 60);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));

async function enterWorld() {
  await page.goto(`http://localhost:${PORT}`, { waitUntil: "networkidle2" });
  await page.waitForFunction(
    () =>
      document.querySelector(".hud-pos") ||
      document.querySelector(".char-card") ||
      [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
    { timeout: 15000 },
  );
  const stage = await page.evaluate(() => {
    if (document.querySelector(".hud-pos")) return "world";
    if (document.querySelector(".char-card")) return "select";
    return "login";
  });
  if (stage === "login") {
    await page.evaluate(() => {
      [...document.querySelectorAll("button")].find((b) => b.textContent.includes("DEV LOGIN")).click();
    });
    await page.waitForSelector(".char-card", { timeout: 15000 });
  }
  if (stage !== "world") {
    await page.evaluate(() => document.querySelector(".char-card").click());
    await page.waitForSelector(".hud-pos", { timeout: 20000 });
  }
}

let entered = false;
for (let attempt = 1; attempt <= 4 && !entered; attempt++) {
  try {
    await enterWorld();
    entered = true;
  } catch (err) {
    console.log(`[attempt ${attempt}] join failed: ${String(err.message).split("\n")[0]}`);
  }
}
if (!entered) {
  console.log("FAILED to enter world");
  await browser.close();
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 5000));

const dump = await page.evaluate(
  ({ cx, cz, r }) => {
    const store = window.__game?.chunks;
    if (!store) return { error: "no chunk store" };
    const out = [];
    // ChunkStore internals: find any map of chunks.
    const maps = Object.values(store).filter((v) => v instanceof Map);
    for (const m of maps) {
      for (const chunk of m.values()) {
        if (!chunk?.buildings || !chunk.coord) continue;
        const ox = chunk.coord.x * 32;
        const oz = chunk.coord.z * 32;
        for (const b of chunk.buildings) {
          const x0 = ox + b.tx0 * 2;
          const x1 = ox + b.tx1 * 2;
          const z0 = oz + b.tz0 * 2;
          const z1 = oz + b.tz1 * 2;
          const mx = (x0 + x1) / 2;
          const mz = (z0 + z1) / 2;
          if (Math.abs(mx - cx) > r || Math.abs(mz - cz) > r) continue;
          out.push({
            x: [x0, x1],
            z: [z0, z1],
            arch: b.archetype,
            stories: b.stories,
            style: b.style >>> 0,
          });
        }
      }
    }
    return { count: out.length, buildings: out };
  },
  { cx: CX, cz: CZ, r: R },
);
console.log(JSON.stringify(dump, null, 1));
await browser.close();
