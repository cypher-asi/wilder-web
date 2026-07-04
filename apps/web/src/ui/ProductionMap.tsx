// Economy Map: traversable mine -> refine -> build graph (Economy menu
// sub-tab). Five fixed columns — Resources, Refinery recipes, Materials,
// Factory recipes, Items — with SVG edges wired straight from the RECIPES
// mirror, so the view can never drift from the real production data.
// Clicking a card highlights its full upstream + downstream chain; the
// currencies table below shows the V1 faucet/sink design with live
// minted/burned totals from the economy subscription.

import { useMemo } from "react";
import {
  BASE_VALUES,
  DEFAULT_BLUEPRINTS,
  NODE_RESOURCES,
  Recipe,
  RECIPES,
  RESEARCH_ENERGY,
  RESEARCH_FRAGMENTS,
  RESEARCH_RESOURCES,
  RESOURCE_COLORS,
  resourceSourceZones,
  VENDOR_PRICES,
} from "../game/recipes";
import { ItemKind } from "../net/protocol";
import { useGame } from "../state/game";
import { itemLabel } from "./ItemIcon";

// ---------------------------------------------------------------------------
// Graph model (derived entirely from recipes.ts)
// ---------------------------------------------------------------------------

const REFINERY_RECIPES = RECIPES.filter((r) => r.station === "Refinery");
const FACTORY_RECIPES = RECIPES.filter((r) => r.station === "Factory");
const MATERIALS = REFINERY_RECIPES.map((r) => r.output[0]);
const ITEMS = FACTORY_RECIPES.map((r) => r.output[0]);

/** Graph node id for the card holding an item kind. */
function kindNode(kind: ItemKind): string {
  if (NODE_RESOURCES.includes(kind)) return `res:${kind}`;
  if (MATERIALS.includes(kind)) return `mat:${kind}`;
  return `item:${kind}`;
}

/** Directed input->recipe->output edges over every recipe. */
const EDGES: { from: string; to: string; kind: ItemKind }[] = RECIPES.flatMap((r) => [
  ...r.inputs.map(([kind]) => ({ from: kindNode(kind), to: `rec:${r.id}`, kind })),
  { from: `rec:${r.id}`, to: kindNode(r.output[0]), kind: r.output[0] },
]);

/** Full upstream + downstream closure of a node (BFS both directions). */
function chainClosure(start: string): Set<string> {
  const out = new Set([start]);
  const walk = (dir: "from" | "to") => {
    const frontier = [start];
    while (frontier.length > 0) {
      const node = frontier.pop()!;
      for (const e of EDGES) {
        const next = dir === "from" ? (e.to === node ? e.from : null) : (e.from === node ? e.to : null);
        if (next && !out.has(next)) {
          out.add(next);
          frontier.push(next);
        }
      }
    }
  };
  walk("from");
  walk("to");
  return out;
}

// ---------------------------------------------------------------------------
// Fixed layout: five columns on an absolute canvas, edges from the same math
// ---------------------------------------------------------------------------

const CARD_H = 84;
const GAP = 8;
const TOP = 26;
const CANVAS_H = TOP + 8 * CARD_H + 7 * GAP + 10;

const COLUMNS: { title: string; x: number; w: number; ids: string[] }[] = [
  { title: "RESOURCES", x: 0, w: 152, ids: NODE_RESOURCES.map((k) => `res:${k}`) },
  { title: "REFINE · REFINERY", x: 212, w: 196, ids: REFINERY_RECIPES.map((r) => `rec:${r.id}`) },
  { title: "MATERIALS", x: 468, w: 152, ids: MATERIALS.map((k) => `mat:${k}`) },
  { title: "BUILD · FACTORY", x: 680, w: 196, ids: FACTORY_RECIPES.map((r) => `rec:${r.id}`) },
  { title: "ITEMS", x: 936, w: 158, ids: ITEMS.map((k) => `item:${k}`) },
];
const CANVAS_W = 936 + 158;

interface CardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Node id -> absolute card rect (columns vertically centered). */
const LAYOUT: Record<string, CardRect> = {};
for (const col of COLUMNS) {
  const total = col.ids.length * CARD_H + (col.ids.length - 1) * GAP;
  const y0 = TOP + (CANVAS_H - TOP - total) / 2;
  col.ids.forEach((id, i) => {
    LAYOUT[id] = { x: col.x, y: y0 + i * (CARD_H + GAP), w: col.w, h: CARD_H };
  });
}

/** Bezier path between two cards (handles the rare right-to-left edge). */
function edgePath(from: CardRect, to: CardRect): string {
  const forward = to.x >= from.x + from.w;
  const x1 = forward ? from.x + from.w : from.x;
  const y1 = from.y + from.h / 2;
  const x2 = forward ? to.x : to.x + to.w;
  const y2 = to.y + to.h / 2;
  const dx = Math.max(Math.abs(x2 - x1) * 0.45, 24) * (forward ? 1 : -1);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function valueOf(kind: ItemKind): number {
  return BASE_VALUES[kind] ?? 0;
}

/** Recipe margin at base values: output value minus summed input values. */
function recipeMargin(r: Recipe): number {
  const out = valueOf(r.output[0]) * r.output[1];
  const inputs = r.inputs.reduce((n, [kind, c]) => n + valueOf(kind) * c, 0);
  return out - inputs;
}

function vendorLines(kind: ItemKind): string[] {
  return VENDOR_PRICES.filter((v) => v.kind === kind).map((v) => {
    const parts = [];
    if (v.buy > 0) parts.push(`buy ${v.buy}`);
    if (v.sell > 0) parts.push(`sell ${v.sell}`);
    return `${v.vendor}: ${parts.join(" · ")}`;
  });
}

function ResourceCard({ kind }: { kind: ItemKind }) {
  const zones = resourceSourceZones(kind);
  return (
    <>
      <div className="pmap-card-name">
        <i className="pmap-chip" style={{ background: RESOURCE_COLORS[kind] }} />
        {itemLabel(kind)}
        <span className="pmap-value">{valueOf(kind)}▪</span>
      </div>
      <div className="pmap-line dim">mined from nodes</div>
      <div className="pmap-line">{zones.join(" · ")}</div>
    </>
  );
}

function RecipeCard({ recipe, known }: { recipe: Recipe; known: boolean }) {
  const margin = recipeMargin(recipe);
  const isDefault = DEFAULT_BLUEPRINTS.includes(recipe.id);
  const researchCost = `${RESEARCH_FRAGMENTS} frags + ${RESEARCH_RESOURCES.map(
    ([k, n]) => `${n} ${itemLabel(k)}`,
  ).join(" + ")} + ${RESEARCH_ENERGY} Energy`;
  return (
    <>
      <div className="pmap-card-name">
        {itemLabel(recipe.output[0])}
        {recipe.output[1] > 1 ? ` x${recipe.output[1]}` : ""}
        <span
          className="pmap-value"
          style={{ color: margin >= 0 ? "#7be0c2" : "#ff6a7c" }}
          title="Margin at base values: output value − input values"
        >
          {margin >= 0 ? "+" : ""}
          {margin}▪
        </span>
      </div>
      <div className="pmap-line">
        {recipe.inputs.map(([kind, n]) => `${n}x ${itemLabel(kind)}`).join(" + ")}
      </div>
      <div className="pmap-line dim">
        {recipe.seconds}s · ⚡{recipe.energy}/unit
      </div>
      {isDefault ? (
        <div className="pmap-badge default">DEFAULT BLUEPRINT</div>
      ) : known ? (
        <div className="pmap-badge known" title={`Researched (cost: ${researchCost})`}>
          RESEARCHED ✓
        </div>
      ) : (
        <div className="pmap-badge locked" title={`Research at the Laboratory: ${researchCost}`}>
          RESEARCH: 2✦ + 5 ELEC + 5 CHEM + ⚡5
        </div>
      )}
    </>
  );
}

function GoodsCard({ kind }: { kind: ItemKind }) {
  const vendors = vendorLines(kind);
  return (
    <>
      <div className="pmap-card-name">
        {itemLabel(kind)}
        <span className="pmap-value">{valueOf(kind)}▪</span>
      </div>
      {vendors.length > 0 ? (
        vendors.map((line) => (
          <div key={line} className="pmap-line">
            {line}
          </div>
        ))
      ) : (
        <div className="pmap-line dim">market / craft input only</div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Currencies panel (V1 currency table + live mint/burn totals)
// ---------------------------------------------------------------------------

interface CurrencyRow {
  name: string;
  tone: string;
  faucets: string;
  sinks: string;
  spentOn: string;
  carried: string;
}

const CURRENCY_ROWS: CurrencyRow[] = [
  {
    name: "MILD",
    tone: "#8fd6ff",
    faucets: "Account grant · kill coin drops · Cash conversion at Bank (−10%) · commerce cuts",
    sinks: "Carried burn on death · market 5% fee · bank conversion fee · unrouted commerce",
    spentOn: "Market · vendors · agent hires",
    carried: "Carried at risk — bank to keep",
  },
  {
    name: "ENERGY",
    tone: "#ffd75e",
    faucets: "Ammo cache taps · 10% kill pickups",
    sinks: "Carried burn on death · every production job & research",
    spentOn: "Refinery/Factory queue jobs · Lab research",
    carried: "Carried at risk — bank to keep",
  },
  {
    name: "SHARDS",
    tone: "#b79bff",
    faucets: "Kill pickups · inventory Destroy salvage",
    sinks: "Carried burn on death only",
    spentOn: "— (reserved)",
    carried: "Carried at risk — bank to keep",
  },
  {
    name: "CASH",
    tone: "#9fe07a",
    faucets: "Kill loot (grubstake kits · 2x in the Blast Zone)",
    sinks: "Bank conversion burns Cash (mints MILD −10%)",
    spentOn: "Bank → MILD conversion (the MILD faucet's carrier)",
    carried: "Physical item — lootable, drops on death",
  },
];

function CurrenciesPanel() {
  const economy = useGame((s) => s.economy);
  const stats = economy?.stats;
  const cash = stats?.items.find((i) => i.kind === "Cash");
  // Live minted/burned per row, in CURRENCY_ROWS order (Cash is an item).
  const live: [number | undefined, number | undefined][] = [
    [stats?.wild_minted, stats?.wild_burned],
    [stats?.energy_minted, stats?.energy_burned],
    [stats?.shards_minted, stats?.shards_burned],
    [cash?.minted, cash?.burned],
  ];
  const n = (v: number | undefined) => (v === undefined ? "…" : v.toLocaleString());
  return (
    <div className="econ-panel pmap-cur">
      <div className="econ-panel-title">
        CURRENCIES
        <span className="econ-panel-sub">LIVE MINT / BURN FROM THE LEDGER</span>
      </div>
      <div className="pmap-cur-row pmap-cur-head">
        <span>CURRENCY</span>
        <span>FAUCETS</span>
        <span>SINKS</span>
        <span>SPENT ON</span>
        <span>CARRIED VS BANKED</span>
        <span className="num">MINTED</span>
        <span className="num">BURNED</span>
      </div>
      {CURRENCY_ROWS.map((row, i) => (
        <div key={row.name} className="pmap-cur-row">
          <span style={{ color: row.tone, fontWeight: 700 }}>{row.name}</span>
          <span>{row.faucets}</span>
          <span>{row.sinks}</span>
          <span style={{ color: row.spentOn.startsWith("—") ? "var(--text-dim)" : undefined }}>
            {row.spentOn}
          </span>
          <span>{row.carried}</span>
          <span className="num" style={{ color: "#9fdcff" }}>
            {n(live[i][0])}
          </span>
          <span className="num" style={{ color: "#ff6a7c" }}>
            {n(live[i][1])}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Map shell
// ---------------------------------------------------------------------------

export function ProductionMap({
  selected,
  onSelect,
}: {
  /** Selected graph node (lifted so Escape can clear it before closing). */
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const blueprints = useGame((s) => s.blueprints);
  const closure = useMemo(() => (selected ? chainClosure(selected) : null), [selected]);

  const dimmed = (id: string) => closure !== null && !closure.has(id);
  const recipeOf = (id: string) => RECIPES.find((r) => `rec:${r.id}` === id);

  return (
    <div className="pmap">
      <div
        className="pmap-canvas"
        style={{ width: CANVAS_W, height: CANVAS_H }}
        onClick={() => onSelect(null)}
      >
        <svg className="pmap-svg" viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}>
          {EDGES.map((e, i) => {
            const from = LAYOUT[e.from];
            const to = LAYOUT[e.to];
            if (!from || !to) return null;
            const active = closure !== null && closure.has(e.from) && closure.has(e.to);
            const color = RESOURCE_COLORS[e.kind] ?? "#4fc3ff";
            return (
              <path
                key={i}
                d={edgePath(from, to)}
                fill="none"
                stroke={color}
                strokeWidth={active ? 2 : 1.1}
                opacity={closure === null ? 0.4 : active ? 0.9 : 0.06}
              />
            );
          })}
        </svg>
        {COLUMNS.map((col) => (
          <div key={col.title} className="pmap-col-title" style={{ left: col.x, width: col.w }}>
            {col.title}
          </div>
        ))}
        {Object.entries(LAYOUT).map(([id, rect]) => {
          const [kind, key] = id.split(":");
          const recipe = kind === "rec" ? recipeOf(id) : undefined;
          return (
            <div
              key={id}
              className={`pmap-card${selected === id ? " sel" : ""}${dimmed(id) ? " dim" : ""}`}
              style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(selected === id ? null : id);
              }}
              title="Click to trace this node's full chain"
            >
              {kind === "res" && <ResourceCard kind={key as ItemKind} />}
              {recipe && <RecipeCard recipe={recipe} known={blueprints.includes(recipe.id)} />}
              {(kind === "mat" || kind === "item") && <GoodsCard kind={key as ItemKind} />}
            </div>
          );
        })}
      </div>
      <CurrenciesPanel />
    </div>
  );
}
