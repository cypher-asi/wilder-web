// Temporary debug helper: like screenshot.mjs but dumps console + UI state.
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("console", (m) => console.log(`[${m.type()}]`, m.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 500)));

const cdp = await page.createCDPSession();
await cdp.send("Network.enable");
cdp.on("Network.webSocketCreated", (e) => console.log("[ws created]", e.url));
cdp.on("Network.webSocketClosed", () => console.log("[ws closed]"));
cdp.on("Network.webSocketFrameSent", (e) =>
  console.log("[ws sent]", e.response.payloadData.slice(0, 120)),
);
cdp.on("Network.webSocketFrameReceived", (e) => {
  const p = e.response.payloadData;
  if (!p.includes('"Snapshot"') && !p.includes('"Ping"'))
    console.log("[ws recv]", p.slice(0, 150));
});

await page.goto("http://localhost:5175", { waitUntil: "networkidle2" });
await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("DEV LOGIN")).click();
});
await page.waitForSelector(".char-card", { timeout: 15000 });
await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".char-card")].filter((c) =>
    c.textContent.includes("Shot"),
  );
  (cards[cards.length - 1] ?? document.querySelector(".char-card")).click();
});
await page.waitForSelector("canvas", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 8000));
const state = await page.evaluate(() => ({
  bodyText: document.body.innerText.slice(0, 600),
  canvases: document.querySelectorAll("canvas").length,
}));
console.log("state:", JSON.stringify(state));
await page.screenshot({ path: "tools/screens/empty-debug2.png" });
await browser.close();
