// Shared owned-agents data layer + small presentational widgets, used by both
// the mobile Agents tab (home screen) and the desktop AgentsScreen.
//
// The hook owns the AgentSub lifecycle (subscribe while its host is visible,
// unsubscribe on hide) following the EconomyDashboard pattern, and wraps the
// hire / dismiss / detail-sub C2S messages. Roster/detail/offers state itself
// lives in useGame (filled by GameConnection).

import { useCallback, useEffect } from "react";
import { GameConnection } from "../net/connection";
import {
  AgentDetail,
  AgentLogEntry,
  AgentSummary,
  EconTx,
  Inventory,
  TxAmount,
  TxKind,
  TxParty,
} from "../net/protocol";
import { useGame } from "../state/game";
import { ItemIcon, itemLabel } from "./ItemIcon";

/** Max owned agents per player (mirror of the server cap). */
export const AGENT_CAP = 5;

export function fmtMild(n: number): string {
  return n.toLocaleString("en-US");
}

/** Compact relative age: "12s", "4m", "3h", "2d", then a short date. */
export function formatAge(atMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - atMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(atMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface UseAgentsApi {
  /** Owned roster (null until the first AgentRoster push lands). */
  roster: AgentSummary[] | null;
  /** Watched agent's full detail (AgentDetailSub stream). */
  detail: AgentDetail | null;
  /** Hire candidates (AgentHireList response), cheapest first. */
  hireOffers: AgentSummary[] | null;
  /** Last hire/dismiss result (at = receive time, ms). */
  result: { ok: boolean; error: string | null; at: number } | null;
  hire: (agentId: string) => void;
  dismiss: (agentId: string) => void;
  requestHireList: () => void;
  openDetail: (agentId: string) => void;
  closeDetail: () => void;
}

/**
 * Manage the AgentSub subscription while `open`, and expose the roster plus
 * hire / dismiss / detail helpers. Roster data is intentionally kept in the
 * store after hide so the next open renders instantly (like the economy feed).
 */
export function useAgents(connection: GameConnection, open: boolean): UseAgentsApi {
  const roster = useGame((s) => s.agentRoster);
  const detail = useGame((s) => s.agentDetail);
  const hireOffers = useGame((s) => s.agentHireOffers);
  const result = useGame((s) => s.agentResult);
  const connected = useGame((s) => s.connected);

  useEffect(() => {
    if (!open || !connected) return;
    connection.send({ t: "AgentSub", d: { on: true } });
    return () => {
      connection.send({ t: "AgentSub", d: { on: false } });
    };
  }, [open, connected, connection]);

  const hire = useCallback(
    (agentId: string) => {
      useGame.getState().set({ agentResult: null });
      connection.send({ t: "HireAgent", d: { agent_id: agentId } });
    },
    [connection],
  );

  const dismiss = useCallback(
    (agentId: string) => {
      useGame.getState().set({ agentResult: null });
      connection.send({ t: "DismissAgent", d: { agent_id: agentId } });
    },
    [connection],
  );

  const requestHireList = useCallback(() => {
    useGame.getState().set({ agentHireOffers: null });
    connection.send({ t: "AgentHireList" });
  }, [connection]);

  const openDetail = useCallback(
    (agentId: string) => {
      useGame.getState().set({ agentDetail: null });
      connection.send({ t: "AgentDetailSub", d: { agent_id: agentId } });
    },
    [connection],
  );

  const closeDetail = useCallback(() => {
    connection.send({ t: "AgentDetailSub", d: { agent_id: null } });
    useGame.getState().set({ agentDetail: null });
  }, [connection]);

  return {
    roster,
    detail,
    hireOffers,
    result,
    hire,
    dismiss,
    requestHireList,
    openDetail,
    closeDetail,
  };
}

/** Registry color for a faction id as CSS hex (falls back to accent blue). */
export function useFactionMeta(): (id: number) => { name: string; color: string } {
  const factions = useGame((s) => s.factions);
  return useCallback(
    (id: number) => {
      const f = factions.find((f) => f.id === id);
      return {
        name: f?.name ?? "Unaligned",
        color: `#${(f?.color ?? 0x4fc3ff).toString(16).padStart(6, "0")}`,
      };
    },
    [factions],
  );
}

// ---------------------------------------------------------------------------
// Shared widgets (styled by the ag-* classes in theme.css)
// ---------------------------------------------------------------------------

export function AgentHpBar({ health, maxHealth }: { health: number; maxHealth: number }) {
  const pct = Math.max(0, Math.min(1, health / Math.max(maxHealth, 1)));
  return (
    <div className="ag-hp" title={`${Math.round(health)}/${Math.round(maxHealth)} HP`}>
      <div
        className={`ag-hp-fill${pct <= 0.3 ? " low" : ""}`}
        style={{ width: `${pct * 100}%` }}
      />
    </div>
  );
}

/**
 * Learned activity payoffs as labeled horizontal bars; the max (the agent's
 * archetype driver) is highlighted.
 */
export function TraitBars({ traits }: { traits: [string, number][] }) {
  const max = Math.max(...traits.map(([, v]) => v), 0.0001);
  const maxIdx = traits.reduce((best, [, v], i) => (v > traits[best][1] ? i : best), 0);
  return (
    <div className="ag-traits">
      {traits.map(([name, value], i) => (
        <div key={name} className={`ag-trait${i === maxIdx ? " top" : ""}`}>
          <span className="ag-trait-name">{name}</span>
          <span className="ag-trait-bar">
            <span
              className="ag-trait-fill"
              style={{ width: `${Math.max((value / max) * 100, 1.5)}%` }}
            />
          </span>
          <span className="ag-trait-val num">{value.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
}

const STAT_LABELS: [keyof AgentDetail["stats"], string][] = [
  ["kills", "KILLS"],
  ["deaths", "DEATHS"],
  ["resources", "RESOURCES"],
  ["trades", "TRADES"],
  ["crafted", "CRAFTED"],
];

export function AgentStatsGrid({ stats }: { stats: AgentDetail["stats"] }) {
  return (
    <div className="ag-stats">
      {STAT_LABELS.map(([key, label]) => (
        <div key={key} className="ag-stat">
          <span className="ag-stat-val num">{stats[key].toLocaleString("en-US")}</span>
          <span className="ag-stat-label">{label}</span>
        </div>
      ))}
    </div>
  );
}

/** Carried / banked / lifetime-earnings wallet strip. */
export function AgentWallet({
  carried,
  banked,
  earned,
}: {
  carried: number;
  banked: number;
  earned: number;
}) {
  return (
    <div className="ag-wallet">
      <div className="ag-wallet-cell">
        <span className="ag-wallet-val num">{fmtMild(carried)}</span>
        <span className="ag-wallet-label">CARRIED</span>
      </div>
      <div className="ag-wallet-cell">
        <span className="ag-wallet-val num">{fmtMild(banked)}</span>
        <span className="ag-wallet-label">BANKED</span>
      </div>
      <div className="ag-wallet-cell earned">
        <span className="ag-wallet-val num">+{fmtMild(earned)}</span>
        <span className="ag-wallet-label">EARNED YOU</span>
      </div>
    </div>
  );
}

/** Inventory grid with the equipped weapon/armor row shown distinctly. */
export function AgentInventory({ inventory }: { inventory: Inventory }) {
  const equipped = [
    { kind: inventory.equipped_weapon, tag: "W1" },
    { kind: inventory.equipped_weapon2, tag: "W2" },
    { kind: inventory.equipped_armor, tag: "AR" },
  ];
  const stacks = inventory.slots.filter((s) => s !== null);
  return (
    <div className="ag-inv">
      <div className="ag-inv-equipped">
        {equipped.map((e, i) => (
          <div
            key={i}
            className={`ag-inv-slot equipped${e.kind ? "" : " empty"}`}
            title={e.kind ? `${itemLabel(e.kind)} (equipped)` : "Empty"}
          >
            {e.kind ? <ItemIcon kind={e.kind} size={26} /> : <span className="ag-inv-dash">—</span>}
            <span className="ag-inv-tag">{e.tag}</span>
          </div>
        ))}
      </div>
      <div className="ag-inv-grid">
        {stacks.length === 0 && <div className="ag-empty-note">Backpack empty.</div>}
        {stacks.map((s, i) => (
          <div key={i} className="ag-inv-slot" title={itemLabel(s!.kind)}>
            <ItemIcon kind={s!.kind} size={26} />
            {s!.count > 1 && <span className="ag-inv-count">{s!.count}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Reverse-chron activity feed with relative timestamps. */
export function AgentActivityFeed({ log, now }: { log: AgentLogEntry[]; now: number }) {
  if (log.length === 0) {
    return <div className="ag-empty-note">No activity recorded yet.</div>;
  }
  // Server sends oldest first; show newest on top.
  const rows = [...log].reverse();
  return (
    <div className="ag-feed">
      {rows.map((e, i) => (
        <div key={`${e.at_ms}-${i}`} className="ag-feed-row">
          <span className="ag-feed-text">{e.text}</span>
          <span className="ag-feed-age num">{formatAge(e.at_ms, now)}</span>
        </div>
      ))}
    </div>
  );
}

// --- Transaction rows (compact copies of the EconomyDashboard formatters) ---

const TX_KIND_LABEL: Record<TxKind, string> = {
  Mint: "MINT",
  Burn: "BURN",
  LootPickup: "LOOT",
  Drop: "DROP",
  VendorBuy: "VENDOR BUY",
  VendorSell: "VENDOR SELL",
  BankConvert: "BANK",
  MarketList: "MKT LIST",
  MarketBuy: "MKT BUY",
  MarketCancel: "MKT CANCEL",
  CraftConsume: "CRAFT IN",
  CraftProduce: "CRAFT OUT",
  Fee: "FEE",
  Extract: "EXTRACT",
  AgentHire: "HIRE",
  OwnerShare: "OWNER SHARE",
};

function partyName(party: TxParty): string {
  switch (party.t) {
    case "Player":
    case "Agent":
      return party.d.name;
    case "Mint":
    case "Burn":
      return "GIBSON";
  }
}

function amountText(amount: TxAmount): string {
  switch (amount.t) {
    case "Item":
      return `${amount.d.count} ${itemLabel(amount.d.kind)}`;
    case "Wild":
      return `${fmtMild(amount.d.amount)} MILD`;
    case "Shards":
      return `${fmtMild(amount.d.amount)} SHARDS`;
    case "Energy":
      return `${fmtMild(amount.d.amount)} ENERGY`;
    case "Blueprint":
      return `BP: ${amount.d.recipe}`;
  }
}

/**
 * Recent ledger transactions touching one agent: kind, amount, counterparty.
 * The counterparty is whichever side isn't the agent itself.
 */
export function AgentTxList({
  txs,
  agentId,
  now,
}: {
  txs: EconTx[];
  agentId: string;
  now: number;
}) {
  if (txs.length === 0) {
    return <div className="ag-empty-note">No transactions yet.</div>;
  }
  return (
    <div className="ag-txs">
      {txs.map((tx) => {
        const fromIsAgent = tx.from.t === "Agent" && tx.from.d.id === agentId;
        const counter = fromIsAgent ? tx.to : tx.from;
        const outgoing = fromIsAgent;
        return (
          <div key={tx.seq} className="ag-tx-row">
            <span className="ag-tx-kind">{TX_KIND_LABEL[tx.kind]}</span>
            <span className={`ag-tx-amount num${outgoing ? " out" : " in"}`}>
              {outgoing ? "−" : "+"}
              {amountText(tx.amount)}
            </span>
            <span className="ag-tx-party">
              {outgoing ? "→ " : "← "}
              {partyName(counter)}
            </span>
            <span className="ag-tx-age num">{formatAge(tx.at_ms, now)}</span>
          </div>
        );
      })}
    </div>
  );
}
