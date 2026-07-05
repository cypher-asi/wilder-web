// Fullscreen Agents section of the central menu (desktop): two-pane layout
// with the owned-agent roster + hire panel on the left and the selected
// agent's live detail on the right. Shares the useAgents hook (AgentSub /
// AgentDetailSub) with the mobile Agents tab.

import { useEffect, useState } from "react";
import { GameConnection } from "../net/connection";
import { AgentSummary } from "../net/protocol";
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
} from "./useAgents";

export function AgentsScreen({ connection }: { connection: GameConnection }) {
  const open = useGame((s) => s.menuOpen && s.menuTab === "agents");
  const agents = useAgents(connection, open);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hireOpen, setHireOpen] = useState(false);

  const roster = agents.roster;

  // Default the detail pane to the first agent once the roster lands, and
  // drop the selection if the agent leaves the roster. A respawn mints a
  // fresh identity for the same slot — the detail stream keeps flowing with
  // the new agent_id — so follow it instead of bouncing off the selection.
  const detailId = agents.detail?.summary.agent_id ?? null;
  useEffect(() => {
    if (!open || roster === null) return;
    if (selectedId && !roster.some((a) => a.agent_id === selectedId)) {
      if (detailId && roster.some((a) => a.agent_id === detailId)) {
        setSelectedId(detailId);
      } else {
        setSelectedId(null);
      }
    } else if (!selectedId && roster.length > 0) {
      setSelectedId(roster[0].agent_id);
    }
  }, [open, roster, selectedId, detailId]);

  // Detail subscription follows the selected agent while the screen is up.
  // Keyed on `joined` so the detail sub is re-sent after a reconnect.
  const joined = useGame((s) => s.joined);
  useEffect(() => {
    if (!open || !joined || !selectedId) return;
    agents.openDetail(selectedId);
    return () => agents.closeDetail();
  }, [open, joined, selectedId, agents.openDetail, agents.closeDetail]);

  if (!open) return null;

  const owned = roster?.length ?? 0;
  const selected = roster?.find((a) => a.agent_id === selectedId) ?? null;

  return (
    <div className="map-overlay ag-overlay">
      <div className="ag-screen">
        <div className="econ-panel ag-roster-panel">
          <div className="econ-panel-title">
            AGENTS
            <span className="econ-panel-sub">
              {owned}/{AGENT_CAP} OWNED
            </span>
          </div>
          <button
            type="button"
            className="ag-hire-toggle"
            disabled={owned >= AGENT_CAP}
            onClick={() => {
              if (!hireOpen) agents.requestHireList();
              setHireOpen(!hireOpen);
            }}
          >
            {hireOpen ? "‹ BACK TO ROSTER" : owned >= AGENT_CAP ? "ROSTER FULL" : "+ HIRE AGENT"}
          </button>
          {hireOpen ? (
            <HirePanel agents={agents} firstFree={owned === 0} onHired={() => setHireOpen(false)} />
          ) : (
            <div className="ag-roster-list">
              {roster === null && <div className="econ-empty">Syncing roster…</div>}
              {roster !== null && roster.length === 0 && (
                <div className="ag-roster-empty">
                  <div className="ag-empty-title">NO AGENTS YET</div>
                  <div className="ag-roster-empty-sub">
                    Agents roam the city and earn for you around the clock.
                    Your first hire is free.
                  </div>
                </div>
              )}
              {roster?.map((a) => (
                <RosterRow
                  key={a.agent_id}
                  agent={a}
                  active={a.agent_id === selectedId}
                  onClick={() => setSelectedId(a.agent_id)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="econ-panel ag-detail-panel">
          {selected ? (
            <DetailPane summary={selected} agents={agents} />
          ) : (
            <div className="econ-empty">
              {owned === 0
                ? "Hire your first agent to start earning."
                : "Select an agent to inspect it."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RosterRow({
  agent,
  active,
  onClick,
}: {
  agent: AgentSummary;
  active: boolean;
  onClick: () => void;
}) {
  const factionMeta = useFactionMeta();
  const f = factionMeta(agent.faction);
  return (
    <div className={`ag-roster-row${active ? " active" : ""}`} role="button" onClick={onClick}>
      <div className="ag-card-top">
        <span className="ag-card-name">{agent.name}</span>
        <span className="ag-chip">{agent.archetype}</span>
      </div>
      <div className="ag-card-org">
        <span style={{ color: f.color }}>{f.name.toUpperCase()}</span>
        {agent.guild && <span> · {agent.guild}</span>}
        <span> · {agent.activity}</span>
      </div>
      <AgentHpBar health={agent.health} maxHealth={agent.max_health} />
      <div className="ag-card-money">
        <span className="ag-card-wild">
          {fmtMild(agent.carried_wild)}
          <span className="ag-card-banked"> +{fmtMild(agent.banked_wild)}▪</span>
          <span className="ag-card-cur"> MILD</span>
        </span>
        <span className="ag-card-earned">+{fmtMild(agent.lifetime_owner_earnings)} earned</span>
      </div>
    </div>
  );
}

function DetailPane({ summary, agents }: { summary: AgentSummary; agents: UseAgentsApi }) {
  const factionMeta = useFactionMeta();
  const startWatch = useGame((s) => s.startWatch);
  const detail = agents.detail?.summary.agent_id === summary.agent_id ? agents.detail : null;
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Reset the dismiss confirm step when switching agents.
  useEffect(() => setConfirmDismiss(false), [summary.agent_id]);

  const f = factionMeta(summary.faction);
  const s = detail?.summary ?? summary;

  return (
    <div className="ag-detail">
      <div className="ag-detail-head">
        <div>
          <div className="ag-detail-name">{s.name}</div>
          <div className="ag-card-org">
            <span className="ag-chip">{s.archetype}</span>{" "}
            <span style={{ color: f.color }}>{f.name.toUpperCase()}</span>
            {s.guild && <span> · {s.guild}</span>}
          </div>
        </div>
        <div className="ag-detail-actions">
          <button
            type="button"
            className="ag-watch-btn"
            onClick={() => startWatch(summary.agent_id)}
            title="Follow this agent live in the world"
          >
            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
              <circle cx="12" cy="12" r="2.6" />
            </svg>
            WATCH LIVE
          </button>
          {confirmDismiss ? (
            <>
              <button
                type="button"
                className="ag-dismiss yes"
                onClick={() => {
                  agents.dismiss(summary.agent_id);
                  setConfirmDismiss(false);
                }}
              >
                CONFIRM DISMISS
              </button>
              <button type="button" className="ag-dismiss" onClick={() => setConfirmDismiss(false)}>
                KEEP
              </button>
            </>
          ) : (
            <button type="button" className="ag-dismiss" onClick={() => setConfirmDismiss(true)}>
              DISMISS
            </button>
          )}
        </div>
      </div>

      <div className="ag-detail-vitals">
        <AgentHpBar health={s.health} maxHealth={s.max_health} />
        <div className="ag-goal">» {detail?.goal ?? s.activity}</div>
      </div>

      <div className="ag-detail-cols">
        <div className="ag-detail-col">
          <div className="ag-sec-title">WALLET</div>
          <AgentWallet
            carried={detail?.carried[0] ?? s.carried_wild}
            banked={detail?.banked[0] ?? s.banked_wild}
            earned={s.lifetime_owner_earnings}
          />
          {detail && (
            <>
              <div className="ag-sec-title">RECORD</div>
              <AgentStatsGrid stats={detail.stats} />
              <div className="ag-sec-title">TRAITS · MILD/MIN</div>
              <TraitBars traits={detail.traits} />
              <div className="ag-sec-title">INVENTORY</div>
              <AgentInventory inventory={detail.inventory} />
            </>
          )}
        </div>
        <div className="ag-detail-col">
          {detail ? (
            <>
              <div className="ag-sec-title">ACTIVITY</div>
              <AgentActivityFeed log={detail.activity_log} now={now} />
              <div className="ag-sec-title">TRANSACTIONS</div>
              <AgentTxList txs={detail.recent_txs} agentId={summary.agent_id} now={now} />
            </>
          ) : (
            <div className="econ-empty">Loading detail…</div>
          )}
        </div>
      </div>
    </div>
  );
}

function HirePanel({
  agents,
  firstFree,
  onHired,
}: {
  agents: UseAgentsApi;
  firstFree: boolean;
  onHired: () => void;
}) {
  const factionMeta = useFactionMeta();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const result = agents.result;
  useEffect(() => {
    if (!pendingId || !result) return;
    if (result.ok) {
      onHired();
    } else {
      setError(result.error ?? "Hire failed");
      setPendingId(null);
    }
  }, [pendingId, result, onHired]);

  const offers = agents.hireOffers;

  return (
    <div className="ag-roster-list">
      {firstFree && <div className="ag-hire-banner">YOUR FIRST HIRE IS FREE</div>}
      {error && <div className="ag-hire-error">{error}</div>}
      {offers === null && <div className="econ-empty">Scouting candidates…</div>}
      {offers !== null && offers.length === 0 && (
        <div className="econ-empty">No candidates available right now.</div>
      )}
      {offers?.map((o) => {
        const f = factionMeta(o.faction);
        const cost = o.hire_cost ?? 0;
        const free = cost === 0;
        const pending = pendingId === o.agent_id;
        return (
          <div key={o.agent_id} className="ag-roster-row ag-offer-row">
            <div className="ag-card-top">
              <span className="ag-card-name">{o.name}</span>
              <span className="ag-chip">{o.archetype}</span>
            </div>
            <div className="ag-card-org">
              <span style={{ color: f.color }}>{f.name.toUpperCase()}</span>
              {o.guild && <span> · {o.guild}</span>}
              <span> · {fmtMild(o.carried_wild + o.banked_wild)} MILD wealth</span>
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
              {pending ? "HIRING…" : free ? "HIRE — FREE" : `HIRE — ${fmtMild(cost)} MILD`}
            </button>
          </div>
        );
      })}
    </div>
  );
}
