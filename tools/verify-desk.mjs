// Quick desk verification: log in, subscribe to the markets index, and
// report how many tickers carry a live price / bid / ask / volume.
// Usage: E2E_PORT=8093 node tools/verify-desk.mjs
const PORT = process.env.E2E_PORT ?? "8080";
const BASE = `http://localhost:${PORT}`;

const creds = { username: "desk_verify", password: "e2e-password-1" };
let res = await fetch(`${BASE}/api/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(creds),
});
if (!res.ok) {
  res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(creds),
  });
}
if (!res.ok) throw new Error(`auth failed: ${res.status}`);
const token = (await res.json()).token;
const headers = { authorization: `Bearer ${token}` };
let chars = await (await fetch(`${BASE}/api/characters`, { headers })).json();
if (!chars.length) {
  const created = await fetch(`${BASE}/api/characters`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "DeskVerify" }),
  });
  chars = [await created.json()];
}

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
ws.binaryType = "arraybuffer";
let markets = null;
ws.onopen = () => ws.send(JSON.stringify({ t: "Authenticate", d: { token } }));
ws.onerror = (e) => console.error("ws error", e?.message ?? e);
ws.onmessage = (ev) => {
  if (typeof ev.data !== "string") return;
  const msg = JSON.parse(ev.data);
  if (msg.t === "AuthResult")
    ws.send(JSON.stringify({ t: "JoinWorld", d: { character_id: chars[0].id } }));
  if (msg.t === "WorldJoined") ws.send(JSON.stringify({ t: "MarketsSub", d: { on: true } }));
  if (msg.t === "Ping") ws.send(JSON.stringify({ t: "Pong", d: { nonce: msg.d.nonce } }));
  if (msg.t === "MarketsState") markets = msg.d;
};

const deadline = Date.now() + 30000;
while (!markets && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
if (!markets) {
  console.error("FAIL: no MarketsState received");
  process.exit(1);
}
const rows = markets.rows;
const priced = rows.filter((r) => r.last > 0);
const withBid = rows.filter((r) => r.best_bid > 0);
const withAsk = rows.filter((r) => r.best_ask > 0);
const withVol = rows.filter((r) => r.volume_24h_wild > 0);
console.log(`tickers: ${rows.length}`);
console.log(`priced (last>0): ${priced.length}`);
console.log(`with bid: ${withBid.length}, with ask: ${withAsk.length}`);
console.log(`with 24h volume: ${withVol.length}`);
for (const r of rows) {
  console.log(
    `${r.ticker.padEnd(6)} last=${r.last} bid=${r.best_bid} ask=${r.best_ask} vol24h=${r.volume_24h_wild} venues=${r.venues.length}`
  );
}
const ok = priced.length === rows.length && withBid.length === rows.length && withAsk.length === rows.length;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
