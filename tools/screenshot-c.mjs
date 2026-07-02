// Phase C screenshot driver: like screenshot.mjs but supports camera rotation
// (Q key) and multiple walk segments so storefront (-z/-x) faces can be framed.
// Usage: node tools/screenshot-c.mjs <name> [--zoom N] [--rot ms] [--walk dx,dz,ms[;dx,dz,ms...]]

import puppeteer from "puppeteer";

const outPrefix = process.argv[2] ?? "shot";
const args = process.argv.slice(3);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const zoomSteps = Number(argValue("--zoom") ?? 0);
const rotMs = Number(argValue("--rot") ?? 0); // hold Q this long (1.8 rad/s)
const walk = argValue("--walk");
const cam = argValue("--cam"); // "yawDeg,distance" exact camera override

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

await page.waitForFunction(
  () => document.querySelector(".char-card") || document.querySelector("input.field"),
  { timeout: 15000 },
);
const hasChar = await page.evaluate(() => !!document.querySelector(".char-card"));
if (!hasChar) {
  await page.type("input.field", "Shot");
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.includes("CREATE RUNNER"))
      .click();
  });
  await page.waitForSelector(".char-card", { timeout: 15000 });
}
await page.click(".char-card");

await page.waitForSelector("canvas", { timeout: 20000 });
// Join is racy under HMR: if the HUD never appears, reload and re-enter.
for (let attempt = 0; attempt < 4; attempt++) {
  try {
    await page.waitForSelector(".hud-name", { timeout: 9000 });
    break;
  } catch {
    console.log("join failed, reloading...");
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForFunction(
      () =>
        document.querySelector(".char-card") ||
        [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
      { timeout: 15000 },
    );
    const needLogin = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        b.textContent.includes("DEV LOGIN"),
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (needLogin) await page.waitForSelector(".char-card", { timeout: 15000 });
    await page.click(".char-card");
    await page.waitForSelector("canvas", { timeout: 20000 });
  }
}
await new Promise((r) => setTimeout(r, 7000));

if (walk) {
  for (const seg of walk.split(";")) {
    const [dx, dz, ms] = seg.split(",").map(Number);
    const key = dz < 0 ? "KeyW" : dz > 0 ? "KeyS" : dx < 0 ? "KeyA" : "KeyD";
    await page.keyboard.down(key);
    await new Promise((r) => setTimeout(r, ms || 2000));
    await page.keyboard.up(key);
    await new Promise((r) => setTimeout(r, 400));
  }
  await new Promise((r) => setTimeout(r, 800));
}

if (rotMs !== 0) {
  const key = rotMs > 0 ? "KeyQ" : "KeyE";
  await page.keyboard.down(key);
  await new Promise((r) => setTimeout(r, Math.abs(rotMs)));
  await page.keyboard.up(key);
  await new Promise((r) => setTimeout(r, 500));
}

if (cam) {
  const [yawDeg, distance] = cam.split(",").map(Number);
  const applied = await page.evaluate(
    async (yaw, dist) => {
      const mod = await import("/src/render/CameraRig.tsx");
      mod.cameraState.yaw = (yaw * Math.PI) / 180;
      if (dist) mod.cameraState.distance = dist;
      return { yaw: mod.cameraState.yaw, distance: mod.cameraState.distance };
    },
    yawDeg,
    distance,
  );
  console.log("camera:", JSON.stringify(applied));
  await new Promise((r) => setTimeout(r, 1200));
}

if (zoomSteps !== 0) {
  await page.mouse.move(800, 450);
  for (let i = 0; i < Math.abs(zoomSteps); i++) {
    await page.mouse.wheel({ deltaY: zoomSteps > 0 ? -120 : 120 });
    await new Promise((r) => setTimeout(r, 120));
  }
  await new Promise((r) => setTimeout(r, 1200));
}

await page.screenshot({ path: `tools/screens/${outPrefix}.png` });
console.log(`saved tools/screens/${outPrefix}.png`);
await browser.close();
