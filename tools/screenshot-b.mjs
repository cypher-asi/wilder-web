// Screenshot driver (Phase B variant): same as screenshot.mjs but uses a
// dedicated character ("ShotB") so runs don't collide with other agents'
// sessions ("character already in world" makes the join silently fail).
// Usage: node tools/screenshot-b.mjs [outPrefix] [--zoom N] [--walk dx,dz,ms]

import puppeteer from "puppeteer";

const CHAR_NAME = "Shot"; // clicks the LAST card matching this name
const outPrefix = process.argv[2] ?? "shot";
const args = process.argv.slice(3);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const zoomSteps = Number(argValue("--zoom") ?? 0);
const tilt = Number(argValue("--tilt") ?? 0); // RMB-drag dy in px (negative = tilt camera lower)
const walk = argValue("--walk");
const tp = argValue("--tp"); // "x,z" dev teleport via chat

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("[page error]", m.text());
});

await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });

await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("DEV LOGIN")).click();
});

await page.waitForSelector(".char-card", { timeout: 15000 });
// Try character cards from the last one backwards until one joins (a card can
// be blocked by a lingering "already in world" session from a previous run).
const cardCount = await page.evaluate(() => document.querySelectorAll(".char-card").length);
let joined = false;
for (let i = cardCount - 1; i >= 0 && !joined; i--) {
  await page.evaluate((idx) => document.querySelectorAll(".char-card")[idx].click(), i);
  await page.waitForSelector("canvas", { timeout: 20000 });
  joined = await page
    .waitForFunction(() => document.body.innerText.includes("Welcome to Wilder"), {
      timeout: 8000,
    })
    .then(() => true)
    .catch(() => false);
  if (!joined) {
    console.log(`card ${i} did not join, trying next`);
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector(".char-card", { timeout: 15000 });
  }
}
if (!joined) throw new Error("no character could join");
await new Promise((r) => setTimeout(r, 7000));

if (tp) {
  const [x, z] = tp.split(",").map(Number);
  // Open chat (window keydown), type the dev teleport command, submit.
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter", bubbles: true })),
  );
  await new Promise((r) => setTimeout(r, 500));
  const hasInput = await page.$(".chat-input");
  console.log("chat input open:", !!hasInput);
  if (hasInput) {
    await page.type(".chat-input", `/tp ${x} ${z}`, { delay: 20 });
    await page.keyboard.press("Enter");
  }
  await new Promise((r) => setTimeout(r, 3500));
  console.log("hud:", await page.evaluate(() => document.body.innerText.split("\n")[1]));
}

if (zoomSteps !== 0) {
  await page.mouse.move(800, 450);
  for (let i = 0; i < Math.abs(zoomSteps); i++) {
    await page.mouse.wheel({ deltaY: zoomSteps > 0 ? -120 : 120 });
    await new Promise((r) => setTimeout(r, 120));
  }
  await new Promise((r) => setTimeout(r, 1200));
}

if (tilt !== 0) {
  // Hold RMB and drag vertically; keep the button held through the screenshot
  // since the tilt eases back to the fixed pitch on release.
  await page.mouse.move(800, 450);
  await page.mouse.down({ button: "right" });
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(800, 450 + (tilt * i) / 12);
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 600));
}

if (walk) {
  const [dx, dz, ms] = walk.split(",").map(Number);
  const key = dz < 0 ? "KeyW" : dz > 0 ? "KeyS" : dx < 0 ? "KeyA" : "KeyD";
  await page.keyboard.down(key);
  await new Promise((r) => setTimeout(r, ms || 2000));
  await page.keyboard.up(key);
  await new Promise((r) => setTimeout(r, 800));
}

await page.screenshot({ path: `tools/screens/${outPrefix}.png` });
console.log(`saved tools/screens/${outPrefix}.png`);
await browser.close();
