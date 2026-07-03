// Validation helper: joins the world with the dev character, walks near a
// target so its chunks stream in, then renders free-camera views via the
// __scene/__gl dev handles (bypassing the follow camera entirely).
//
//   CAM="x,y,z" LOOK="x,y,z" SHOT=tools/screens/foo node tools/shot-freecam.mjs
//
// Multiple views: CAMS="x,y,z@x,y,z;x,y,z@x,y,z" (cam@look pairs).
import puppeteer from "puppeteer";

const PORT = process.env.PORT ?? "5173";
const PREFIX = process.env.SHOT ?? "tools/screens/freecam";
// Walk target (to stream the right chunks); defaults to under the first cam.
const views = [];
if (process.env.CAMS) {
  for (const pair of process.env.CAMS.split(";").filter(Boolean)) {
    const [cam, look] = pair.split("@");
    views.push({ cam: cam.split(",").map(Number), look: look.split(",").map(Number) });
  }
} else {
  views.push({
    cam: (process.env.CAM ?? "40,30,-80").split(",").map(Number),
    look: (process.env.LOOK ?? "40,10,-44").split(",").map(Number),
  });
}
const TX = Number(process.env.TX ?? views[0].look[0]);
const TZ = Number(process.env.TZ ?? views[0].look[2]);
const WAYPOINTS = (process.env.WAYPOINTS ?? "")
  .split(";")
  .filter(Boolean)
  .map((s) => {
    const [x, z] = s.split(",").map(Number);
    return { x, z };
  });

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 400)));

// STYLE=blueHour etc: pre-seed the persisted visual style before the app boots.
if (process.env.STYLE) {
  await page.evaluateOnNewDocument(
    (s) => localStorage.setItem("wilder.visualStyle", s),
    process.env.STYLE,
  );
}

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
    await page.waitForSelector("canvas", { timeout: 20000 });
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
await new Promise((r) => setTimeout(r, 6000));

async function getPos() {
  return page.evaluate(() => {
    const el = document.querySelector(".hud-pos");
    if (!el) return null;
    const m = el.textContent.match(/(-?[\d.]+),\s*(-?[\d.]+)/);
    return m ? { x: Number(m[1]), z: Number(m[2]) } : null;
  });
}

function keyFor(dx, dz) {
  if (dx > 1.5 && dz > 1.5) return "s";
  if (dx > 1.5 && dz < -1.5) return "d";
  if (dx < -1.5 && dz > 1.5) return "a";
  if (dx < -1.5 && dz < -1.5) return "w";
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? "s" : "w";
  return dz > 0 ? "s" : "w";
}

await page.keyboard.down("Shift");
for (const [wi, wp] of [...WAYPOINTS, { x: TX, z: TZ }].entries()) {
  let stuck = 0;
  let last = null;
  for (let i = 0; i < 120; i++) {
    const pos = await getPos();
    if (!pos) break;
    const dx = wp.x - pos.x;
    const dz = wp.z - pos.z;
    if (Math.hypot(dx, dz) < 5) break;
    if (last && Math.hypot(pos.x - last.x, pos.z - last.z) < 0.4) {
      if (++stuck > 7) break;
    } else {
      stuck = 0;
    }
    last = pos;
    const key = keyFor(dx, dz);
    await page.keyboard.down(key);
    await new Promise((r) => setTimeout(r, 400));
    await page.keyboard.up(key);
  }
  console.log(`waypoint ${wi} done at`, JSON.stringify(await getPos()));
}
await page.keyboard.up("Shift");
// Let streaming/instancing settle at the final position.
await new Promise((r) => setTimeout(r, 4000));

for (const [i, v] of views.entries()) {
  // The CameraRig honors window.__freecam (dev-only) and pins the camera, so
  // the game's own render loop (with postprocessing) draws the view.
  await page.evaluate(
    ({ cam, look }) => {
      window.__freecam = { pos: cam, look };
    },
    { cam: v.cam, look: v.look },
  );
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: `${PREFIX}-${i + 1}.png` });
  console.log(`saved ${PREFIX}-${i + 1}.png`);
}
await page.evaluate(() => {
  window.__freecam = null;
});

console.log("done");
await browser.close();
