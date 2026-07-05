// Mobile Watch-tab probe: phone viewport + touch emulation, dev login, open
// the Watch tab, dump render-pipeline diagnostics, and screenshot.
// Usage: node tools/shot-mobile-watch.mjs [outPrefix] [--url http://localhost:5173]

import puppeteer from "puppeteer";

const outPrefix = process.argv[2] ?? "mobile-watch";
const args = process.argv.slice(3);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const url = argValue("--url") ?? "http://localhost:5173";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=420,900", "--use-gl=angle"],
  defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
});
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("[page error]", m.text());
});

await page.goto(url, { waitUntil: "networkidle2" });

// Boot: guest auto-login may land on characters or straight in-game; a dev
// login button may exist instead. Handle all three.
await page.waitForFunction(
  () =>
    document.querySelector("canvas") ||
    document.querySelector(".char-card") ||
    document.querySelector("input.field") ||
    [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
  { timeout: 20000 },
);
const stage = await page.evaluate(() => {
  if (document.querySelector("canvas")) return "game";
  if (document.querySelector(".char-card")) return "chars";
  if ([...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")))
    return "login";
  return "create";
});
console.log("boot stage:", stage);
if (stage === "login") {
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.includes("DEV LOGIN"))
      .click();
  });
  await page.waitForFunction(
    () => document.querySelector(".char-card") || document.querySelector("input.field"),
    { timeout: 15000 },
  );
}
if (stage !== "game") {
  const hasChar = await page.evaluate(() => !!document.querySelector(".char-card"));
  if (!hasChar) {
    await page.type("input.field", "MobShot");
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent.includes("CREATE RUNNER"))
        .click();
    });
    await page.waitForSelector(".char-card", { timeout: 15000 });
  }
  await page.click(".char-card");
}

// Wait for the mobile shell, then open the Watch tab.
await page.waitForSelector("canvas", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 4000));

// No owned agents yet: hire one through the Agents tab sheet so the Watch
// tab has a subject (also exercises the legacy hire flow on old servers).
const rosterEmpty = await page.evaluate(
  () => (window.__ui?.getState?.().agentRoster?.length ?? 0) === 0,
);
if (rosterEmpty) {
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent.includes("HIRE"),
    );
    if (btn) btn.click();
    return btn?.textContent ?? null;
  });
  console.log("opened hire sheet via:", JSON.stringify(opened));
  await page
    .waitForSelector(".ag-offer-btn", { timeout: 15000 })
    .catch(() => console.log("no hire offers appeared"));
  await page.evaluate(() => {
    document.querySelector(".ag-offer-btn")?.click();
  });
  await page
    .waitForFunction(
      () => (window.__ui?.getState?.().agentRoster?.length ?? 0) > 0,
      { timeout: 15000 },
    )
    .catch(() => console.log("roster still empty after hire"));
  // Close the sheet if it's still up.
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.className.includes("sheet-close") || b.textContent.trim() === "✕")
      ?.click();
  });
  await new Promise((r) => setTimeout(r, 1000));
}
const tabs = await page.evaluate(() =>
  [...document.querySelectorAll("button")].map((b) => b.textContent.trim()),
);
console.log("buttons:", JSON.stringify(tabs));
const clicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    b.textContent.toUpperCase().includes("WATCH"),
  );
  if (btn) btn.click();
  return !!btn;
});
console.log("clicked watch tab:", clicked);

// Let the watch anchor, chunk streaming, and chunk builds settle (shader
// prewarm on headless ANGLE is slow, give it time to reveal chunks).
await page
  .waitForFunction(
    () => (window.__chunkPipeline?.revealed.size ?? 0) > 5,
    { timeout: 45000, polling: 1000 },
  )
  .catch(() => console.log("chunks still unrevealed after 45s"));
await new Promise((r) => setTimeout(r, 5000));

const diag = await page.evaluate(() => {
  const g = window.__game;
  const ui = window.__ui?.getState?.();
  const pipeline = window.__chunkPipeline;
  const cam = window.__camera;
  return {
    joined: ui?.joined,
    worldReady: ui?.worldReady,
    mobileTab: ui?.mobileTab,
    watchAgentId: ui?.watchAgentId,
    rosterLen: ui?.agentRoster?.length ?? null,
    rosterFirst: ui?.agentRoster?.[0]
      ? {
          name: ui.agentRoster[0].name,
          x: ui.agentRoster[0].x,
          z: ui.agentRoster[0].z,
          entity: ui.agentRoster[0].entity_id,
        }
      : null,
    visualStyle: ui?.visualStyle,
    chunksStored: g ? g.chunks.chunks.size : null,
    chunkKeys: g ? [...g.chunks.chunks.keys()].slice(0, 8) : null,
    entities: g ? g.entities.size : null,
    predicted: g ? { ...g.predicted } : null,
    rendered: g ? { ...g.rendered } : null,
    revealed: pipeline ? pipeline.revealed.size : null,
    prewarming: pipeline ? pipeline.prewarming.size : null,
    prewarmed: pipeline ? pipeline.prewarmed.size : null,
    camPos: cam ? { x: cam.position.x, y: cam.position.y, z: cam.position.z } : null,
  };
});
console.log("diag:", JSON.stringify(diag, null, 2));

await page.screenshot({ path: `tools/screens/${outPrefix}.png` });
console.log(`saved tools/screens/${outPrefix}.png`);
await browser.close();
