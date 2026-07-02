# Wilder

A persistent-world extraction MMO with a player-driven economy, rendered as a
high-fidelity 3D isometric city in the browser.

- **Client:** React + TypeScript + Vite + React Three Fiber (`apps/web`)
- **Server:** Rust + Tokio + Axum + WebSockets (`crates/*`)
- **Persistence:** embedded key-value store (local-first, no Docker required)
- **Spec:** [specs/spec-mvp.md](specs/spec-mvp.md)

## Development

Prerequisites: Rust (stable), Node.js 20+.

```powershell
# Terminal 1 — backend (serves HTTP + WebSocket + assets on :8080)
$env:WILDER_DEV = "1"; cargo run -p wilder-gateway

# Terminal 2 — frontend (Vite dev server on :5173, proxies to :8080)
npm install
npm run dev -w apps/web
```

Open http://localhost:5173 and click **Dev Login** to jump straight into the world.

## Repository layout

```
apps/web/            React + R3F client
crates/wilder-*      Rust server crates (gateway, world, auth, persistence, ...)
shared/wilder-*      Protocol + shared types (Rust, mirrored to TypeScript)
assets/              Game assets (glTF, textures, audio) + manifest + attribution
specs/               Design specifications
tools/               Internal tools (admin, balance, replay)
```

## Phase roadmap

Each phase ships as a workable MVP (see the spec for gates):

0. Technical foundation — persistent city one player can walk forever
0.5. Standalone economy simulator
1. Extraction prototype — fight, loot, extract, stash
2. Resource economy — gather, refine, craft everything
3. Manufacturing — buildings, queues, blueprints, power, market
