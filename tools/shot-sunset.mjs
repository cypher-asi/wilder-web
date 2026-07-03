// Screenshot looking toward the low western sun: zooms out, tilts to the
// horizon, and rotates the camera yaw to face the sun azimuth (dev only).
// Usage: node tools/shot-sunset.mjs [outPrefix] [rotateSeconds]
import puppeteer from "puppeteer";

const outPrefix = process.argv[2] ?? "sunset";
const rotateSeconds = Number(process.argv[3] ?? 0.64); // X key at 1.8 rad/s

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });

await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("DEV LOGIN")).click();
});
await page.waitForFunction(
  () => document.querySelector(".char-card") || document.querySelector("input.field"),
  { timeout: 15000 },
);
// Other tooling sessions share the same dev account and can hold a character
// ("character already in world"), so try each runner until one joins.
await page.waitForSelector(".char-card", { timeout: 15000 });
// Prefer Dev/Shot runners; E2E idles inside a safe-zone shop interior.
const cardOrder = await page.evaluate(() =>
  [...document.querySelectorAll(".char-card")]
    .map((c, i) => ({ i, name: c.textContent }))
    .sort((a, b) => Number(a.name.includes("E2E")) - Number(b.name.includes("E2E")))
    .map(({ i }) => i),
);
let joined = false;
for (const i of cardOrder) {
  if (joined) break;
  await page.evaluate((idx) => document.querySelectorAll(".char-card")[idx].click(), i);
  await page.waitForSelector("canvas", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 8000));
  joined = await page.evaluate(() => document.body.innerText.includes("PISTOL"));
  if (!joined) {
    console.error(`join failed on char ${i}; retrying with next`);
    await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });
    await page.waitForSelector(".char-card", { timeout: 15000 });
  }
}
if (!joined) {
  console.error("world did not join (no HUD); aborting shot");
  await browser.close();
  process.exit(2);
}

// Walk forward a few seconds to clear whatever wall the runner idles against.
await page.keyboard.down("KeyW");
await new Promise((r) => setTimeout(r, 3000));
await page.keyboard.up("KeyW");
await new Promise((r) => setTimeout(r, 600));

// RMB drag upward: lowers pitch toward the horizon.
await page.mouse.move(800, 450);
await page.mouse.down({ button: "right" });
for (let i = 0; i < 20; i++) {
  await page.mouse.move(800, 450 - 16 * (i + 1));
  await new Promise((r) => setTimeout(r, 30));
}
await page.mouse.up({ button: "right" });

// Rotate yaw (X key) to face the western sun.
await page.keyboard.down("KeyX");
await new Promise((r) => setTimeout(r, rotateSeconds * 1000));
await page.keyboard.up("KeyX");
await new Promise((r) => setTimeout(r, 1500));

await page.screenshot({ path: `tools/screens/${outPrefix}.png` });
console.log(`saved tools/screens/${outPrefix}.png`);
await browser.close();
