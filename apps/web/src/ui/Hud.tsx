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
          <div className="hud-hint">
            CLICK to move · WASD to run · Q/E rotate · SCROLL zoom · I inventory · ENTER chat
          </div>
          <Chat lines={chat} connection={connection} />
          {inventoryOpen && <InventoryPanel connection={connection} />}
        </>
      )}
    </div>
  );
}

function PositionReadout() {
  const [pos, setPos] = useState({ x: 0, z: 0 });
  useEffect(() => {
    const timer = setInterval(() => {
      setPos({ x: game.predicted.x, z: game.predicted.z });
    }, 500);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="hud-pos">
      {pos.x.toFixed(1)}, {pos.z.toFixed(1)} · chunk {Math.floor(pos.x / 32)},{" "}
      {Math.floor(pos.z / 32)}
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

function InventoryPanel({ connection }: { connection: GameConnection }) {
  const inventory = useGame((s) => s.inventory);
  const [selected, setSelected] = useState<number | null>(null);
  if (!inventory) return null;

  function onSlotClick(index: number) {
    if (selected === null) {
      if (inventory!.slots[index]) setSelected(index);
    } else if (selected === index) {
      // Double-click same slot: try to equip.
      connection.send({
        t: "InventoryAction",
        d: { t: "Equip", d: { slot: selected } },
      });
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
    </div>
  );
}

function shortName(kind: string): string {
  return kind.replace(/([a-z])([A-Z])/g, "$1 $2").slice(0, 12);
}
