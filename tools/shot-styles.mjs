// Screenshot all visual styles with an RMB-drag tilt so the sky is visible.
// Usage: node tools/shot-styles.mjs [outPrefix] [dragY]
import puppeteer from "puppeteer";

const outPrefix = process.argv[2] ?? "style";
const dragY = Number(process.argv[3] ?? 300);
// Optional explicit list: node tools/shot-styles.mjs out 300 animeDusk,animeSunset
const onlyStyles = process.argv[4] ? process.argv[4].split(",") : null;

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
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
// Create a character if the account has none (fresh world DB).
if (!(await page.$(".char-card"))) {
  await page.type("input.field", "Dev");
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.includes("CREATE RUNNER"))
      .click();
  });
  await page.waitForSelector(".char-card", { timeout: 15000 });
}
await page.click(".char-card");
await page.waitForFunction(() => window.__ui?.getState?.().joined === true, {
  timeout: 20000,
});
await new Promise((r) => setTimeout(r, 8000));

// Rotate the camera away from the spawn-facing wall (Z key orbits), zoom out
// a bit, then RMB-drag upward: lowers pitch toward the horizon.
await page.mouse.move(800, 450);
await page.keyboard.down("KeyZ");
await new Promise((r) => setTimeout(r, 1200));
await page.keyboard.up("KeyZ");
await page.mouse.wheel({ deltaY: 600 });
await new Promise((r) => setTimeout(r, 500));
await page.mouse.down({ button: "right" });
for (let i = 0; i < 20; i++) {
  await page.mouse.move(800, 450 - (dragY / 20) * (i + 1));
  await new Promise((r) => setTimeout(r, 30));
}
await page.mouse.up({ button: "right" });
await new Promise((r) => setTimeout(r, 1000));

let STYLE_IDS = onlyStyles ??
  (await page.evaluate(() =>
    [...document.querySelectorAll(".style-picker option")].map((o) => o.value),
  ));
if (!STYLE_IDS || STYLE_IDS.length === 0) {
  console.warn("style-picker not found in DOM; falling back to store keys");
  STYLE_IDS = await page.evaluate(() => {
    const ui = window.__ui?.getState?.();
    return ui ? [ui.visualStyle] : [];
  });
}
console.log("styles:", STYLE_IDS.join(", "));

for (const id of STYLE_IDS) {
  await page.evaluate((styleId) => {
    window.__ui.getState().setVisualStyle(styleId);
  }, id);
  await new Promise((r) => setTimeout(r, 3500));
  await page.screenshot({ path: `tools/screens/${outPrefix}-${id}.png` });
  console.log(`saved tools/screens/${outPrefix}-${id}.png`);
}

await browser.close();
