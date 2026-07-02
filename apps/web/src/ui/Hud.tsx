import { FormEvent, useEffect, useRef, useState } from "react";
import { GameConnection } from "../net/connection";
import { game, useGame } from "../state/game";

export function Hud({ connection }: { connection: GameConnection }) {
  const { connected, joined, characterName, health, maxHealth, chat, inventoryOpen } =
    useGame();

  return (
    <div className="hud">
      {!connected && <div className="disconnect-banner">RECONNECTING…</div>}
      {joined && (
        <>
          <div className="hud-top-left">
            <div className="hud-name">{characterName}</div>
            <div className="hp-bar">
              <div
                className="hp-fill"
                style={{ width: `${(health / Math.max(maxHealth, 1)) * 100}%` }}
              />
            </div>
            <PositionReadout />
          </div>
          <ExtractionBar />
          <ExtractHint />
          <div className="hud-hint">
            CLICK move · WASD run · SPACE / click enemy attack · Q/E rotate · I inventory ·
            ENTER chat
          </div>
          <Chat lines={chat} connection={connection} />
          {inventoryOpen && <InventoryPanel connection={connection} />}
        </>
      )}
    </div>
  );
}

function ExtractionBar() {
  const extracting = useGame((s) => s.extracting);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!extracting) return;
    const timer = setInterval(() => {
      const elapsed = (performance.now() - extracting.startedAt) / 1000;
      setProgress(Math.min(elapsed / extracting.seconds, 1));
    }, 50);
    return () => clearInterval(timer);
  }, [extracting]);

  if (!extracting) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: "38%",
        left: "50%",
        transform: "translateX(-50%)",
        width: 320,
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 13,
          letterSpacing: "0.25em",
          color: "#1affc4",
          marginBottom: 8,
          textShadow: "0 0 12px rgba(26,255,196,0.6)",
        }}
      >
        EXTRACTING…
      </div>
      <div className="hp-bar" style={{ height: 10 }}>
        <div
          className="hp-fill"
          style={{
            width: `${progress * 100}%`,
            background: "linear-gradient(90deg, #0fbf93, #1affc4)",
            transition: "none",
          }}
        />
      </div>
    </div>
  );
}

/** Compass hint to the nearest extraction point while in the hostile zone. */
function ExtractHint() {
  const [hint, setHint] = useState<{ dist: number; dir: string } | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      const px = game.predicted.x;
      const pz = game.predicted.z;
      const cx = Math.floor(px / 32);
      const cz = Math.floor(pz / 32);
      const safe = Math.abs(cx) <= 1 && Math.abs(cz) <= 1;
      if (safe) {
        setHint(null);
        return;
      }
      let best: { dist: number; dir: string } | null = null;
      for (const e of game.entities.values()) {
        if (e.kind !== "ExtractionPoint") continue;
        const dx = e.x - px;
        const dz = e.z - pz;
        const dist = Math.hypot(dx, dz);
        if (!best || dist < best.dist) {
          const ns = dz < -3 ? "N" : dz > 3 ? "S" : "";
          const ew = dx > 3 ? "E" : dx < -3 ? "W" : "";
          best = { dist, dir: ns + ew || "HERE" };
        }
      }
      setHint(best);
    }, 500);
    return () => clearInterval(timer);
  }, []);
  if (!hint) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 14,
        left: "50%",
        transform: "translateX(-50%)",
        fontSize: 12,
        letterSpacing: "0.2em",
        color: "#1affc4",
        textShadow: "0 0 10px rgba(26,255,196,0.5)",
        pointerEvents: "none",
      }}
    >
      {hint.dist < 4
        ? "◆ EXTRACTION POINT — CLICK IT, THEN STAND STILL"
        : `◆ EXTRACT ${Math.round(hint.dist)}m ${hint.dir}`}
    </div>
  );
}

function PositionReadout() {
  const [pos, setPos] = useState({ x: 0, z: 0 });
  useEffect(() => {
    const timer = setInterval(() => {
      setPos({ x: game.predicted.x, z: game.predicted.z });
      // Track stash proximity for the deposit/withdraw UI.
      let near = false;
      for (const entity of game.entities.values()) {
        if (entity.kind === "Building") {
          const d = Math.hypot(entity.x - game.predicted.x, entity.z - game.predicted.z);
          if (d < 3.5) {
            near = true;
            break;
          }
        }
      }
      if (near !== useGame.getState().nearStash) {
        useGame.getState().set({ nearStash: near });
      }
    }, 300);
    return () => clearInterval(timer);
  }, []);
  const cx = Math.floor(pos.x / 32);
  const cz = Math.floor(pos.z / 32);
  const safe = Math.abs(cx) <= 1 && Math.abs(cz) <= 1;
  return (
    <div className="hud-pos">
      {pos.x.toFixed(1)}, {pos.z.toFixed(1)} · chunk {cx}, {cz} ·{" "}
      <span style={{ color: safe ? "#29d98c" : "#ff5d7a" }}>
        {safe ? "SAFE ZONE" : "HOSTILE"}
      </span>
    </div>
  );
}

function Chat({
  lines,
  connection,
}: {
  lines: { from: string; text: string; system?: boolean }[];
  connection: GameConnection;
}) {
  const chatOpen = useGame((s) => s.chatOpen);
  const set = useGame((s) => s.set);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (chatOpen) inputRef.current?.focus();
  }, [chatOpen]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (text) connection.send({ t: "Chat", d: { text } });
    setDraft("");
    set({ chatOpen: false });
    inputRef.current?.blur();
  }

  return (
    <div className="chat">
      <div className="chat-lines">
        {[...lines].reverse().map((line, i) => (
          <div key={i} className={`chat-line${line.system ? " system" : ""}`}>
            {!line.system && <span className="from">{line.from}: </span>}
            {line.text}
          </div>
        ))}
      </div>
      {chatOpen && (
        <form onSubmit={submit}>
          <input
            ref={inputRef}
            className="chat-input"
            value={draft}
            placeholder="Say something…"
            maxLength={240}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                set({ chatOpen: false });
                (e.target as HTMLInputElement).blur();
              }
              e.stopPropagation();
            }}
          />
        </form>
      )}
    </div>
  );
}

const WEAPONS = ["Pipe", "Knife", "Pistol", "Smg"];
const ARMOR = ["JacketArmor", "PlateArmor"];

function InventoryPanel({ connection }: { connection: GameConnection }) {
  const inventory = useGame((s) => s.inventory);
  const stash = useGame((s) => s.stash);
  const nearStash = useGame((s) => s.nearStash);
  const [selected, setSelected] = useState<number | null>(null);
  if (!inventory) return null;

  function onSlotClick(index: number) {
    const slot = inventory!.slots[index];
    if (selected === null) {
      if (slot) setSelected(index);
    } else if (selected === index) {
      // Second click on the same slot: contextual action.
      const kind = slot?.kind ?? "";
      if (kind === "Medkit") {
        connection.send({ t: "UseItem", d: { slot: selected } });
      } else if (WEAPONS.includes(kind) || ARMOR.includes(kind)) {
        connection.send({ t: "InventoryAction", d: { t: "Equip", d: { slot: selected } } });
      } else if (nearStash) {
        connection.send({ t: "InventoryAction", d: { t: "Deposit", d: { slot: selected } } });
      }
      setSelected(null);
    } else {
      connection.send({
        t: "InventoryAction",
        d: { t: "MoveSlot", d: { from: selected, to: index } },
      });
      setSelected(null);
    }
  }

  return (
    <div className="inventory">
      <h3>Inventory</h3>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10 }}>
        Weapon: {inventory.equipped_weapon ?? "—"} · Armor: {inventory.equipped_armor ?? "—"}
      </div>
      <div className="inv-grid">
        {inventory.slots.map((slot, i) => (
          <div
            key={i}
            className="inv-slot"
            style={selected === i ? { borderColor: "#ff2d78" } : undefined}
            onClick={() => onSlotClick(i)}
            title={slot ? `${slot.kind} x${slot.count}` : ""}
          >
            {slot && (
              <>
                <span>{shortName(slot.kind)}</span>
                {slot.count > 1 && <span className="inv-count">{slot.count}</span>}
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 8 }}>
        Click item, click again: equip / use{nearStash ? " / deposit" : ""}. Click two
        slots to move.
      </div>
      {nearStash && stash && (
        <>
          <h3 style={{ marginTop: 16 }}>Stash</h3>
          <div className="inv-grid">
            {stash.map((slot, i) => (
              <div
                key={i}
                className="inv-slot"
                onClick={() => {
                  if (slot) {
                    connection.send({
                      t: "InventoryAction",
                      d: { t: "Withdraw", d: { stash_slot: i } },
                    });
                  }
                }}
                title={slot ? `${slot.kind} x${slot.count} (click to withdraw)` : ""}
              >
                {slot && (
                  <>
                    <span>{shortName(slot.kind)}</span>
                    {slot.count > 1 && <span className="inv-count">{slot.count}</span>}
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function shortName(kind: string): string {
  return kind.replace(/([a-z])([A-Z])/g, "$1 $2").slice(0, 12);
}
