// Mobile home screen: the player's owned-agent roster. Card list with a
// drill-in detail page (stacked navigation via local state) and a hire flow
// in a bottom sheet. Data comes from the shared useAgents hook (AgentSub /
// AgentDetailSub streams).

import { useEffect, useState } from "react";
import { GameConnection } from "../net/connection";
import { AgentDetail, AgentSummary } from "../net/protocol";
import { useGame } from "../state/game";
import {
  AGENT_CAP,
  AgentActivityFeed,
  AgentHpBar,
  AgentInventory,
  AgentStatsGrid,
  AgentTxList,
  AgentWallet,
  fmtMild,
  TraitBars,
  useAgents,
  UseAgentsApi,
  useFactionMeta,
} from "../ui/useAgents";
import { BottomSheet } from "./BottomSheet";

export function AgentsTab({ connection }: { connection: GameConnection }) {
  const agents = useAgents(connection, true);
  // Keyed on `joined` so the sub is re-sent after a reconnect, and gated on
  // `appVisible` so the stream pauses while the app is backgrounded.
  const joined = useGame((s) => s.joined);
  const appVisible = useGame((s) => s.appVisible);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hireOpen, setHireOpen] = useState(false);

  // Detail subscription follows the open detail page.
  useEffect(() => {
    if (!selectedId || !joined || !appVisible) return;
    agents.openDetail(selectedId);
    return () => agents.closeDetail();
  }, [selectedId, joined, appVisible, agents.openDetail, agents.closeDetail]);

  // If the selected agent leaves the roster (dismissed / died), back out —
  // unless it respawned: the same slot comes back under a fresh agent_id and
  // the detail stream keeps flowing with the new identity, so follow it.
  const detailId = agents.detail?.summary.agent_id ?? null;
  useEffect(() => {
    if (
      selectedId &&
      agents.roster !== null &&
      !agents.roster.some((a) => a.agent_id === selectedId)
    ) {
      if (detailId && agents.roster.some((a) => a.agent_id === detailId)) {
        setSelectedId(detailId);
      } else {
        setSelectedId(null);
      }
    }
  }, [selectedId, agents.roster, detailId]);

  const openHire = () => {
    agents.requestHireList();
    setHireOpen(true);
  };

  const selected = agents.roster?.find((a) => a.agent_id === selectedId) ?? null;

  return (
    <div className="m-ag">
      {selected ? (
        <AgentDetailPage
          summary={selected}
          detail={agents.detail?.summary.agent_id === selected.agent_id ? agents.detail : null}
          agents={agents}
          onBack={() => setSelectedId(null)}
        />
      ) : (
        <AgentListPage
          agents={agents}
          onSelect={setSelectedId}
          onHire={openHire}
        />
      )}
      <HireSheet
        open={hireOpen}
        onClose={() => setHireOpen(false)}
        agents={agents}
        firstFree={(agents.roster?.length ?? 0) === 0}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// List page
// ---------------------------------------------------------------------------

function AgentListPage({
  agents,
  onSelect,
  onHire,
}: {
  agents: UseAgentsApi;
  onSelect: (id: string) => void;
  onHire: () => void;
}) {
  const roster = agents.roster;
  const owned = roster?.length ?? 0;
  const atCap = owned >= AGENT_CAP;

  return (
    <>
      <div className="m-ag-head">
        <div>
          <span className="m-ag-title">AGENTS</span>
          <span className="m-ag-count">
            {owned}/{AGENT_CAP}
          </span>
        </div>
        <button
          type="button"
          className="m-ag-hire-btn"
          disabled={atCap}
          onClick={onHire}
          title={atCap ? "Roster full" : "Hire an agent"}
        >
          + HIRE
        </button>
      </div>
      <div className="m-ag-list m-scroll">
        {roster === null && <div className="m-ag-note">SYNCING ROSTER…</div>}
        {roster !== null && roster.length === 0 && <EmptyState onHire={onHire} />}
        {roster?.map((a) => (
          <AgentCard key={a.agent_id} agent={a} onClick={() => onSelect(a.agent_id)} />
        ))}
      </div>
    </>
  );
}

// Rare/transient: the server auto-assigns a starter agent on join, so an
// empty roster only shows for a beat while that grant replicates (or when
// the whole faction is hired out).
function EmptyState({ onHire }: { onHire: () => void }) {
  return (
    <div className="m-ag-empty">
      <div className="m-ag-empty-glyph">◈</div>
      <div className="ag-empty-title">DEPLOYING AGENT</div>
      <div className="m-ag-empty-sub">
        Assigning your first agent… Agents roam the city and earn for you
        around the clock.
      </div>
      <button type="button" className="m-ag-cta" onClick={onHire}>
        HIRE AGENT
      </button>
    </div>
  );
}

function AgentCard({ agent, onClick }: { agent: AgentSummary; onClick: () => void }) {
  const factionMeta = useFactionMeta();
  const f = factionMeta(agent.faction);
  return (
    <button type="button" className="m-ag-card" onClick={onClick}>
      <div className="ag-card-top">
        <span className="ag-card-name">{agent.name}</span>
        <span className="ag-chip">{agent.archetype}</span>
      </div>
      <div className="ag-card-org">
        <span style={{ color: f.color }}>{f.name.toUpperCase()}</span>
        {agent.guild && <span> · {agent.guild}</span>}
      </div>
      <div className="m-ag-card-activity">» {agent.activity}</div>
      <AgentHpBar health={agent.health} maxHealth={agent.max_health} />
      <div className="ag-card-money">
        <span className="ag-card-wild" title="Carried + banked MILD">
          {fmtMild(agent.carried_wild)}
          <span className="ag-card-banked"> +{fmtMild(agent.banked_wild)}▪</span>
          <span className="ag-card-cur"> MILD</span>
        </span>
        <span className="ag-card-earned">
          +{fmtMild(agent.lifetime_owner_earnings)} MILD earned
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Detail page (stacked navigation within the tab)
// ---------------------------------------------------------------------------

function AgentDetailPage({
  summary,
  detail,
  agents,
  onBack,
}: {
  summary: AgentSummary;
  detail: AgentDetail | null;
  agents: UseAgentsApi;
  onBack: () => void;
}) {
  const factionMeta = useFactionMeta();
  const setMobileTab = useGame((s) => s.setMobileTab);
  const set = useGame((s) => s.set);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Tick relative ages in the feeds once a second.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const f = factionMeta(summary.faction);
  const s = detail?.summary ?? summary;

  const watchLive = () => {
    set({ watchAgentId: summary.agent_id });
    setMobileTab("watch");
  };

  return (
    <div className="m-ag-detail m-scroll">
      <div className="m-ag-detail-nav">
        <button type="button" className="m-ag-back" onClick={onBack}>
          ‹ AGENTS
        </button>
        {confirmDismiss ? (
          <span className="ag-dismiss-confirm">
            <span>Dismiss {summary.name}?</span>
            <button
              type="button"
              className="ag-dismiss yes"
              onClick={() => {
                agents.dismiss(summary.agent_id);
                setConfirmDismiss(false);
              }}
            >
              CONFIRM
            </button>
            <button
              type="button"
              className="ag-dismiss"
              onClick={() => setConfirmDismiss(false)}
            >
              KEEP
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="ag-dismiss"
            onClick={() => setConfirmDismiss(true)}
          >
            DISMISS
          </button>
        )}
      </div>

      <div className="m-ag-detail-head">
        <div className="m-ag-detail-id">
          <div className="m-ag-detail-name">{s.name}</div>
          <div className="m-ag-detail-org">
            <span className="ag-chip">{s.archetype}</span>
            <span style={{ color: f.color }}>{f.name.toUpperCase()}</span>
            {s.guild && <span className="m-ag-detail-guild">· {s.guild}</span>}
          </div>
        </div>
        <button type="button" className="m-ag-watch" onClick={watchLive}>
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.8}>
            <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
            <circle cx="12" cy="12" r="2.6" />
          </svg>
          WATCH LIVE
        </button>
      </div>

      <div className="m-ag-sec">
        <AgentHpBar health={s.health} maxHealth={s.max_health} />
        <div className="ag-goal">» {detail?.goal ?? s.activity}</div>
      </div>

      <div className="m-ag-sec">
        <div className="ag-sec-title">WALLET</div>
        <AgentWallet
          carried={detail?.carried[0] ?? s.carried_wild}
          banked={detail?.banked[0] ?? s.banked_wild}
          earned={s.lifetime_owner_earnings}
        />
      </div>

      {detail ? (
        <>
          <div className="m-ag-sec">
            <div className="ag-sec-title">RECORD</div>
            <AgentStatsGrid stats={detail.stats} />
          </div>
          <div className="m-ag-sec">
            <div className="ag-sec-title">TRAITS · MILD/MIN</div>
            <TraitBars traits={detail.traits} />
          </div>
          <div className="m-ag-sec">
            <div className="ag-sec-title">INVENTORY</div>
            <AgentInventory inventory={detail.inventory} />
          </div>
          <div className="m-ag-sec">
            <div className="ag-sec-title">ACTIVITY</div>
            <AgentActivityFeed log={detail.activity_log} now={now} />
          </div>
          <div className="m-ag-sec">
            <div className="ag-sec-title">TRANSACTIONS</div>
            <AgentTxList txs={detail.recent_txs} agentId={summary.agent_id} now={now} />
          </div>
        </>
      ) : (
        <div className="m-ag-note">LOADING DETAIL…</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hire flow (bottom sheet)
// ---------------------------------------------------------------------------

function HireSheet({
  open,
  onClose,
  agents,
  firstFree,
}: {
  open: boolean;
  onClose: () => void;
  agents: UseAgentsApi;
  firstFree: boolean;
}) {
  const factionMeta = useFactionMeta();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state each time the sheet opens.
  useEffect(() => {
    if (open) {
      setPendingId(null);
      setError(null);
    }
  }, [open]);

  // Watch for the hire result: close on success, surface the error inline
  // otherwise. hire() clears agentResult first, so any result while a hire is
  // pending is the answer to it.
  const result = agents.result;
  useEffect(() => {
    if (!open || !pendingId || !result) return;
    if (result.ok) {
      onClose();
    } else {
      setError(result.error ?? "Hire failed");
      setPendingId(null);
    }
  }, [open, pendingId, result, onClose]);

  const offers = agents.hireOffers;

  return (
    <BottomSheet open={open} onClose={onClose} title="HIRE AN AGENT">
      {firstFree && (
        <div className="ag-hire-banner">YOUR FIRST HIRE IS FREE</div>
      )}
      {error && <div className="ag-hire-error">{error}</div>}
      {offers === null && <div className="m-ag-note">SCOUTING CANDIDATES…</div>}
      {offers !== null && offers.length === 0 && (
        <div className="m-ag-note">No candidates available right now.</div>
      )}
      {offers?.map((o) => {
        const f = factionMeta(o.faction);
        const cost = o.hire_cost ?? 0;
        const free = cost === 0;
        const pending = pendingId === o.agent_id;
        return (
          <div key={o.agent_id} className="m-ag-offer">
            <div className="m-ag-offer-info">
              <div className="ag-card-top">
                <span className="ag-card-name">{o.name}</span>
                <span className="ag-chip">{o.archetype}</span>
              </div>
              <div className="ag-card-org">
                <span style={{ color: f.color }}>{f.name.toUpperCase()}</span>
                {o.guild && <span> · {o.guild}</span>}
                <span> · {fmtMild(o.carried_wild + o.banked_wild)} MILD wealth</span>
              </div>
            </div>
            <button
              type="button"
              className={`ag-offer-btn${free ? " free" : ""}`}
              disabled={pending}
              onClick={() => {
                setError(null);
                setPendingId(o.agent_id);
                agents.hire(o.agent_id);
              }}
            >
              {pending ? "HIRING…" : free ? "FREE" : `${fmtMild(cost)} MILD`}
            </button>
          </div>
        );
      })}
    </BottomSheet>
  );
}
