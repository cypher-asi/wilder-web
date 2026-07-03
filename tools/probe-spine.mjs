// Measures torso vs hips vs aim yaw while strafing, to validate the spine
// counter-twist sign in the directional locomotion blender.
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

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
  await page.type("input.field", "Probe");
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.includes("CREATE RUNNER"))
      .click();
  });
  await page.waitForSelector(".char-card", { timeout: 15000 });
}
await page.click(".char-card");
await page.waitForSelector("canvas", { timeout: 20000 });
await page.waitForFunction(() => window.__game && window.__game.localEntityId !== 0, {
  timeout: 30000,
});
await new Promise((r) => setTimeout(r, 3000));

// Fixed aim, then strafe left relative to the screen.
await page.mouse.move(800, 250);
await new Promise((r) => setTimeout(r, 400));

async function measure(label) {
  const out = await page.evaluate(() => {
    const g = window.__game;
    const scene = window.__scene;
    const me = g.entities.get(g.localEntityId);
    // Find the local player's rig: a skinned scene whose world position is
    // within 0.5m of the local entity.
    let hips = null;
    let chest = null;
    scene.traverse((o) => {
      if (o.name === "DEF-hips" || o.name === "DEF-spine003") {
        const p = new window.__THREE_POS.Vector3();
        o.getWorldPosition(p);
        if (Math.hypot(p.x - me.x, p.z - me.z) < 0.7) {
          if (o.name === "DEF-hips") hips = o;
          else chest = o;
        }
      }
    });
    function worldYaw(bone) {
      if (!bone) return null;
      const q = new window.__THREE_POS.Quaternion();
      bone.getWorldQuaternion(q);
      // Bone +Z after skinning ~ character forward for this rig? Measure both
      // +Z and +X projections; report the +Z one.
      const fz = new window.__THREE_POS.Vector3(0, 0, 1).applyQuaternion(q);
      const fx = new window.__THREE_POS.Vector3(1, 0, 0).applyQuaternion(q);
      return {
        z: +Math.atan2(fz.z, fz.x).toFixed(2),
        x: +Math.atan2(fx.z, fx.x).toFixed(2),
      };
    }
    return {
      aimYaw: +g.aim.yaw.toFixed(2),
      entityYaw: +me.yaw.toFixed(2),
      moveYaw: +Math.atan2(me.vz, me.vx).toFixed(2),
      speed: +Math.hypot(me.vx, me.vz).toFixed(2),
      hips: worldYaw(hips),
      chest: worldYaw(chest),
    };
  });
  console.log(label, JSON.stringify(out));
}

// Expose THREE constructors for the probe (grab from any object in scene).
await page.evaluate(() => {
  window.__THREE_POS = {
    Vector3: window.__scene.position.constructor,
    Quaternion: window.__scene.quaternion.constructor,
  };
});

await measure("idle");
await page.keyboard.down("KeyA");
await page.mouse.move(800, 250);
await new Promise((r) => setTimeout(r, 1200));
await page.mouse.move(800, 250);
await measure("strafe_left");
await page.keyboard.up("KeyA");
await page.keyboard.down("KeyS");
await new Promise((r) => setTimeout(r, 1200));
await page.mouse.move(800, 250);
await measure("backpedal");
await page.keyboard.up("KeyS");

await browser.close();
