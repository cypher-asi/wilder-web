# Wilder — MVP Specification (Phases 0-3)

Wilder is a persistent-world extraction MMO with a fully player-driven economy, rendered
as a high-fidelity 3D isometric city in the browser. The server is authoritative for all
game state; the client renders and predicts.

This document specifies the MVP build: **Phase 0 through Phase 3**, plus the
**Phase 0.5 economy simulator**. Later phases (4-10) are summarized at the end for
context so early architecture decisions do not paint us into a corner.

---

## 1. Vision and pillars

1. **Extraction loop first.** Spawn -> fight -> loot -> extract -> stash -> repeat.
   The loop must be fun before any economy exists.
2. **Everything is player-built.** No random legendary drops. Breaches yield resources;
   refineries and factories turn resources into every weapon and tool in the game.
3. **Authoritative server, always.** Never trust clients. The client renders and
   predicts; the server simulates and decides.
4. **A city that feels real.** High-fidelity isometric view (RuneScape-style navigation,
   GTA-like urban density and mood).
5. **Each phase ships as a workable MVP.** We do not begin a phase until the previous
   phase's MVP gate passes end-to-end.

---

## 2. Roadmap and status

All phase 0-3 MVP gates are **implemented, verified end-to-end in the browser, and
committed** (statuses last updated 2026-07-02).

| Phase | Name | MVP gate | Status |
|---|---|---|---|
| 0 | Technical Foundation | One player logs in, creates a character, and walks a persistent high-fidelity city forever; relog restores position and world state. | [x] Done (`43d18f2`) |
| 0.5 | Economy Simulator | Standalone sim runs ~10k agents at 100x speed and emits balance reports (prices, inflation, sinks). | [x] Done (`ce00cc2`) |
| 1 | Extraction Prototype | Spawn -> fight NPCs -> loot -> extract -> stash -> repeat is fully playable; dying loses carried items. | [x] Done (`53805c6`) |
| 2 | Resource Economy | Loot is replaced by resources; players gather, refine, and craft the gear they take into the next breach. | [x] Done (`943ba4f`) |
| 3 | Manufacturing | Buildings, production queues, blueprints, power, professions, and a working market. | [x] Done (`f9ce414`, professions deferred) |
| — | Visual fidelity pass | Rainy neon night city reads as a modern game: AO/SMAA post stack, env reflections, parallax window interiors, animated neon/steam. | [x] Done (`65873b8`) |
| 4-10 | (Future) | Regional economy, guilds, territory, factions, living economy, endgame industry, live ops. | [ ] Not started |

### Delivered feature checklist

- [x] Login/register + one-click dev login (`/dev/login`, dev builds only)
- [x] Character creation, selection, persistence (position/appearance/stats restore on relog)
- [x] Authoritative 20 Hz world sim, WebSocket protocol, client prediction + reconciliation
- [x] Deterministic city generation, chunk streaming, interest-managed entity replication, world save (RocksDB)
- [x] Click-to-move (server A* pathfinding) + WASD, isometric orbit camera
- [x] Inventory + equipment, persistent stash, real CC0 art (KayKit/Kenney/Quaternius/ambientCG) + audio
- [x] Combat (melee/ranged/ammo), NPC AI (patrol/aggro/attack), death drops, loot containers
- [x] Extraction points with channel timer banking loot to stash
- [x] Resource nodes (gather/deplete/respawn) + refinery/factory crafting chain
- [x] Production queues with power budget, laboratory blueprint research (fragment costs)
- [x] Market: listings, buy/cancel, MILD wallet with fee burn
- [x] Economy simulator (`wilder-sim`): 10k agents, sinks/faucets, CSV/JSON balance reports
- [x] Spawn district: 10 service buildings (Storage/Market/Refinery/Factory/Lab/Armory/Bank/Bodega/Dealership/Safehouse) + hostile-ring outposts, POI map legend & holo signage (see §11.5)
- [x] NPC vendors (Armory/Bodega), Cash -> MILD bank conversion, themed resource zones, territory commerce cut
- [ ] Crafting professions/specialization (deferred from Phase 3)
- [ ] Market transaction history (stub)
- [ ] Production queues persistence (currently in-memory per character, inputs refunded on disconnect)
- [ ] Production infra migration: PostgreSQL / Redis / S3 behind existing storage traits (optional, post-MVP)

---

## 3. Technology

### 3.1 Frontend

- React + TypeScript, built with Vite
- Three.js via React Three Fiber (WebGPU-first where available, WebGL2 fallback)
- miniplex (game ECS), Zustand (app/UI state), TanStack Query (HTTP data)
- Rendering is strictly separated from simulation: the client is responsible for
  rendering, input capture, prediction, and interpolation only.

### 3.2 Backend

- Rust, Tokio, Axum, WebSockets
- Authoritative world simulation at a fixed tick (20 Hz)
- Binary protocol (bincode) shared between client and server via `shared/wilder-protocol`

### 3.3 Persistence — local-first strategy

All storage sits behind traits so backends can be swapped without touching game logic:

| Trait | Local implementation (now) | Production target (later) |
|---|---|---|
| `CharacterStore` (accounts, characters, inventory) | RocksDB (embedded) | PostgreSQL |
| `WorldStore` (chunks, world meta) | RocksDB (embedded) | PostgreSQL |
| `SessionStore` (sessions, presence) | In-process map | Redis |
| `AssetStore` (models, textures, audio) | Local filesystem served by gateway | S3-compatible storage |

No Docker, no external services required for local development. A dedicated
(optional, post-Phase-3) migration step introduces the production backends plus a
one-time data migration; it is explicitly **not required now**.

RocksDB column families: `accounts`, `username_index`, `characters`,
`account_characters`, `inventory`, `world_chunks`, `world_meta`.

---

## 4. Repository structure

```
wilder-web/
  Cargo.toml                 # cargo workspace
  package.json               # npm workspace
  apps/
    web/                     # React + Vite + R3F client
  crates/
    wilder-gateway/          # Axum HTTP + WS entry, auth routes, asset serving
    wilder-auth/             # register/login, argon2, session tokens
    wilder-world/            # authoritative sim: tick loop, entities, world save
    wilder-terrain/          # deterministic chunk/city generation
    wilder-physics/          # movement + collision
    wilder-replication/      # interest management, entity snapshots
    wilder-persistence/      # storage traits + RocksDB implementations
    wilder-inventory/        # items, equipment, stash
    wilder-combat/           # Phase 1: health, damage, weapons
    wilder-ai/               # Phase 1: NPC behaviors
    wilder-pathfinding/      # grid/navmesh pathfinding (click-to-move + NPCs)
    wilder-economy/          # Phase 2: resources
    wilder-crafting/         # Phase 2: recipes, refining, crafting
    wilder-market/           # Phase 3: listings, orders
    wilder-telemetry/        # tracing/metrics
    wilder-sim/              # Phase 0.5: standalone economy simulator (binary)
  shared/
    wilder-protocol/         # C2S/S2C wire messages (serde/bincode) + TS mirror
    wilder-types/            # shared domain types
  tools/
    admin/  balance/  replay/   # stubs until needed
  assets/                    # real glTF/textures/audio + manifest + attribution
  specs/
    spec-mvp.md
```

**Crate naming convention:** every Rust crate is prefixed `wilder-`; the package name
equals the directory name (`crates/wilder-gateway` -> `wilder-gateway`, Rust identifier
`wilder_gateway`).

---

## 5. Architecture

```
Client:  React UI  ->  R3F renderer  ->  game ECS  ->  networking (predict/reconcile)
                                                          |  bincode over WebSocket
Server:  gateway (Axum HTTP+WS)  ->  world sim (20 Hz)  ->  physics / replication
                                                          ->  persistence (RocksDB)
```

- The **gateway** terminates HTTP (auth, characters, assets) and WebSockets (game).
- The **world sim** owns all mutable game state and advances it at 20 Hz.
- **Replication** computes per-player interest sets (nearby chunks) and emits entity
  spawn/snapshot/despawn messages at 10-20 Hz.
- **Persistence** saves dirty chunks, characters, and inventories periodically and on
  disconnect.

### 5.1 Networking protocol

Binary bincode messages defined once in `shared/wilder-protocol` and mirrored as
TypeScript types for the client.

Client -> Server:

| Message | Purpose |
|---|---|
| `Authenticate { token }` | Bind the WS connection to a session |
| `JoinWorld { character_id }` | Spawn the character into the sim |
| `MoveInput { seq, dir, dt }` | Direct (WASD) movement input |
| `MoveTo { seq, target }` | Click-to-move request (server pathfinds) |
| `Interact { entity_id }` | Context interaction |
| `InventoryAction { .. }` | Move/equip/drop items |
| `ChatSend { text }` | Chat |
| Phase 1: `AttackInput { target/dir }`, `UseItem { .. }` | Combat |

Server -> Client:

| Message | Purpose |
|---|---|
| `AuthResult`, `WorldJoined` | Handshake |
| `ChunkData { coord, .. }` / `ChunkUnload { coord }` | Chunk streaming |
| `EntitySpawn` / `EntitySnapshot` (delta) / `EntityDespawn` | Replication |
| `InventoryUpdate` | Authoritative inventory state |
| `ChatMessage` | Chat |
| Phase 1: `CombatEvent`, `DeathEvent`, `ExtractResult` | Combat/extraction |

Cadence: sim 20 Hz; snapshots 10-20 Hz, interest-managed (only entities in chunks near
the player). The client predicts the local player per input (tagged with `seq`),
reconciles against the server's last-acknowledged state, and interpolates remote
entities between snapshots.

### 5.2 World model

- The world is an unbounded grid of **chunks** (32 m x 32 m). Chunk content (city
  blocks: roads, buildings, props) is generated deterministically from a world seed +
  chunk coordinate, so unmodified chunks are never stored — only modifications are
  persisted. This is what lets one player walk forever.
- City generation is scale-disciplined (doors ~2.1 m, floors ~3 m, lanes ~3.5 m) and
  assembles chunks from a modular building/prop kit for instancing.
- Collision data derives from the same deterministic generation, so client and server
  agree without shipping collision meshes.

---

## 6. Visual direction — high-fidelity isometric city

Target: RuneScape-style navigation and framing; GTA-like urban fidelity. Mood:
**rainy neon night city** (wet reflective streets, emissive signage, volumetric haze) —
it reads as AAA at isometric range and flatters browser texture budgets.

- **Camera:** perspective camera locked to an isometric-style pitch (~45-60 deg),
  orbiting the player. Drag / Q-E rotates, scroll zooms street-level to overview.
  The camera always frames the character.
- **Controls:** click-to-move primary (server pathfinds; client shows a move marker),
  WASD secondary. Both validated server-side.
- **Fidelity stack (in payoff order):**
  1. WebGPU renderer where available (WebGL2 fallback).
  2. Baked/offline GI for the static city (lightmaps/AO baked per kit piece), HDRI
     image-based lighting, cascaded shadow maps, clustered point lights (streetlights,
     neon), light probes for dynamic entities.
  3. Post stack: TAA/SMAA, GTAO/SSAO, screen-space reflections (wet asphalt), bloom on
     emissives, subtle DOF at low zoom, LUT color grading with AgX/ACES tone mapping.
  4. Material detail: full PBR map sets, parallax interior mapping for lit windows,
     trim sheets + decals (graffiti, road markings, grime, puddle masks).
  5. Atmosphere/life: volumetric fog + light shafts, rain + puddle ripples, steam
     vents, flickering neon, animated traffic lights, ambient audio.
- **Budget:** instancing for all repeated kit pieces, LODs/impostors for far blocks,
  KTX2/BasisU textures, draco/meshopt geometry, chunk-level culling, and a
  low/medium/high/ultra quality ladder.

### 6.1 Asset pipeline (real assets from day one)

- Modular city kit, props, and vehicles from CC0/CC-BY sources (Kenney kits as
  baseline; Poly Haven, Quaternius, KayKit and similar for higher fidelity), PBR
  street/building textures from Poly Haven/ambientCG.
- Rigged, animated character (idle/walk/run) with a Mixamo-compatible humanoid rig.
- Audio: ambient city loop, rain, footsteps, UI sounds (CC0 sources).
- All assets live in `assets/` with a `manifest.json` (id -> path, type, license) served
  by the gateway; every asset is credited in `ASSETS_ATTRIBUTION.md`.
- The pipeline (manifest + loaders) is unchanged when commissioned assets replace
  sourced ones later, or when `AssetStore` moves to S3.

---

## 7. Phase 0 — Technical Foundation

**Goal:** one player can connect, move around, and interact with a persistent world.

Deliverables:

1. **Login** — register/login over HTTP (argon2 password hashing, opaque session
   tokens). **Dev quick-login:** a "Dev Login" button (dev builds only,
   `import.meta.env.DEV`) calls `POST /dev/login`, which creates/reuses a `dev` account
   with a default character and returns a session token. The endpoint is mounted only
   when the server runs with `WILDER_DEV=1`.
2. **Character creation** — name + appearance; character list; select to play.
3. **Character persistence** — position, appearance, stats persist across sessions.
4. **Inventory** — item/equipment model, persisted; inventory UI overlay.
5. **Movement** — server-authoritative with collision; client prediction and
   reconciliation; click-to-move (server-side pathfinding on the city grid) + WASD.
6. **Basic networking** — WS handshake, bincode protocol, heartbeat, clean disconnect.
7. **Chunk streaming** — chunks stream in/out around the player as they move.
8. **Entity replication** — interest-managed spawn/snapshot/despawn.
9. **World save** — modified chunks + character state persist to RocksDB.

**MVP gate:** register (or one-click dev login) -> create character -> walk a
persistent, high-fidelity city indefinitely; chunks stream seamlessly; relog restores
position and world state exactly.

---

## 8. Phase 0.5 — Economy Simulator

A standalone, deterministic (seeded) Rust binary (`crates/wilder-sim`) built **before**
the game economy, and maintained as a balance tool thereafter.

Models: ~10,000 simulated players; resource generation; refining; manufacturing;
trading; death rates; item destruction; market prices; inflation; MILD burns; guild
production.

Runs headless at 100x+ speed (months of gameplay in minutes) and emits CSV/JSON
reports: price curves, inflation, sink/source balance, stockpiles.

**MVP gate:** a full simulated month produces stable, inspectable price/inflation
curves that we use to tune Phase 2/3 recipes, sinks, and generation rates.

---

## 9. Phase 1 — Extraction Prototype

**Goal:** prove the extraction loop is fun. No crafting, no MMO, no economy.

Loop: spawn -> fight NPCs -> loot -> extract -> store loot -> repeat.

Features:

- **Combat:** health, damage, death; melee + ranged weapons; server-side hit
  validation; combat events replicated to clients.
- **NPC AI:** spawning in breach zones; patrol / aggro / attack / flee behaviors;
  pathfinding shared with click-to-move.
- **Loot:** lootable corpses and containers.
- **Extraction:** extraction points with channel timers; extracting banks carried
  loot into persistent home **storage** (stash); **death drops carried items**.
- **Equipment:** weapon/armor slots affect combat.

**MVP gate:** the full loop is playable end-to-end and dying loses carried items.

---

## 10. Phase 2 — Resource Economy

Replace loot with resources. No legendary weapons; no random loot.

- **Resources:** iron, copper, chemicals, electronics, biomass. Every breach produces
  resources (gathering nodes + NPC drops).
- **Crafting chain:** resources -> **refinery** -> materials -> **factory** -> weapons.
  Everything becomes player-built.
- Recipes and rates are tuned from `wilder-sim` outputs before going live.

**MVP gate:** gather resources in breaches, refine to materials, craft the weapons and
gear used in the next breach; random loot is fully removed.

---

## 11. Phase 3 — Manufacturing

Introduce industry; players specialize.

- **Buildings:** refinery, factory, laboratory.
- **Production queues:** timed jobs with input/output buffers.
- **Blueprints:** recipe unlocks researched in the laboratory.
- **Power requirements:** production constrained by available power.
- **Crafting professions:** specialization bonuses per production line.
- **Market:** player listings, buy/sell orders, transaction history, market UI.

**MVP gate:** players specialize, queue production in buildings, unlock blueprints, and
trade on a working market.

---

## 11.5 Spawn district, service buildings & commerce

The player's first area — the safe 3x3 hub around spawn — is a full service district.
Every location has one job, one accent color, and one map glyph (shared taxonomy in
`apps/web/src/game/poi.ts`; placements in `DISTRICT` in `crates/wilder-world`).

### Building taxonomy

| Building | Glyph | What happens there |
| --- | --- | --- |
| **Storage** | S | Stash terminal: deposit/withdraw backpack loot (48 slots) |
| **Market** | M | Player market: list/buy items in MILD (5% fee) |
| **Refinery** | R | Refine resources into materials (timed queues, power) |
| **Factory** | F | Manufacture weapons/gear from materials |
| **Laboratory** | L | Research blueprint unlocks (fragments + resources) |
| **Armory** | A | NPC vendor: buy/sell weapons, armor, ammo in MILD |
| **Bank** | B | Convert looted **Cash** into wallet MILD (10% fee) |
| **Bodega** | G | NPC general store: sells consumables, buys raw resources cheap |
| **Dealership** | D | Vehicle showroom — placeholder until vehicles ship |
| **Safehouse** | H | 10 m safety bubble: hostiles ignore players inside; health regen |

All ten are seeded deterministically at world start across the hub chunks, plus two
**outposts** (Bodega, Bank) in the hostile ring where the surrounding territory is
actually capturable. The server sends a `PoiList` message on join (all POIs + zone
labels), so the fullscreen map (M) can render markers and a legend for the whole
district regardless of streaming distance; the same taxonomy colors the minimap dots
and the floating holo signs on the buildings themselves.

### Cash and the Bank loop

NPCs drop **Cash** (a lootable item, not wallet currency) alongside resources — more
from raiders, double in the Blast Zone. Cash is worthless until carried to a Bank and
converted to MILD at a 10% fee, making it one more thing to lose (or extract) on a run.

### Resource zones

The hostile ring around the hub (out to ~6 chunks) is split into eight themed octants
that bias both resource-node variants and NPC drops (`zone_of_chunk`, weights in
`wilder-economy`): **Blast Zone** (E: chemicals, extra Cash), **Chem Works** (SE),
**Mining Pits** (S: iron/copper), **Scrapyard** (SW: metals), **Overgrowth** (W:
biomass), **Industrial Belt** (N: iron/electronics), **Tech Ruins** (NE: electronics),
and open city (NW and beyond: unbiased). Zone names appear as labels on the map.

### Territory commerce cut

Whoever holds a region takes **10%** of all commerce inside it: vendor purchases and
sales, bank conversion fees, and the market's 5% sale fee. Since territory control is
presence-based in this phase, the cut is split evenly among living players standing in
the player-held region when the transaction happens; on neutral or enemy ground it
burns. Hub regions are protected (always neutral), so the payout only flows at the
hostile-ring outposts — a reason to hold ground.

---

## 12. Testing, observability, dev workflow

- **Server:** unit tests per crate (terrain determinism, movement validation,
  inventory invariants, persistence round-trips); integration test driving a headless
  WS client through login -> join -> move -> relog.
- **Sim:** deterministic seeded runs asserted against golden reports.
- **Telemetry:** `tracing` structured logs; tick-time and snapshot-size metrics.
- **Dev workflow (Windows/PowerShell friendly, no Docker):**
  - `cargo run -p wilder-gateway` — starts the whole backend on `localhost:8080`
    (RocksDB data dir auto-created).
  - `npm run dev -w apps/web` — Vite dev server on `localhost:5173`, proxying to the
    gateway.
  - `WILDER_DEV=1` enables `/dev/login`.

---

## 13. Future phases (context only)

Phase 4 regional economy (per-district prices/storage/demand, logistics); Phase 5
guilds (shared storage, factories, treasury, permissions, projects); Phase 6 territory
(capturable power plants, factories, rail hubs, mines); Phase 7 factions (Empire,
Nomads, AI, Corporation, Resistance; wars; city ownership); Phase 8 living economy
(dynamic supply/demand, convoys, NPC traders, shortages, inflation monitoring,
commodity graphs); Phase 9 endgame industry (orbital elevator, AI supercomputer,
mechs, dropships, guild HQs, research labs); Phase 10 live operations (seasons, new
regions/resources/tech, faction campaigns, balance, analytics).

Architectural hooks already in place for these: trait-based persistence (Postgres/
Redis/S3 swap), interest-managed replication (scales to many players), deterministic
chunked world (regions/districts), `wilder-sim` (economy balance), and the crate split
(`wilder-market`, `wilder-economy` grow into regional pricing; `guild`/`faction`
crates slot in beside them).
