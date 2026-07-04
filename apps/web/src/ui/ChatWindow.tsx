// WoW-style tabbed log window (left edge, above the weapon dock).
// Tabs: CHAT (real chat + input), COMBAT (mock combat log for now),
// STATUS (mock system log + live buff row). Fades when not hovered.

import { FormEvent, useEffect, useRef, useState } from "react";
import { GameConnection } from "../net/connection";
import { cameraState } from "../render/CameraRig";
import { useGame } from "../state/game";

const TABS = ["CHAT", "COMBAT", "STATUS"] as const;
type Tab = (typeof TABS)[number];

/** Mock combat-log lines until this is wired to real CombatEvents. */
const MOCK_COMBAT: { text: string; tone: "out" | "in" | "info" }[] = [
  { text: "You hit Scav for 16.", tone: "out" },
  { text: "You hit Scav for 16. Scav dies.", tone: "out" },
  { text: "Raider hits you for 10 (shield absorbed 10).", tone: "in" },
  { text: "Shockwave hits Raider for 15.", tone: "out" },
  { text: "You hit Raider for 24 (Overcharge).", tone: "out" },
  { text: "Raider hits you for 8.", tone: "in" },
  { text: "+25 XP.", tone: "info" },
];

/** Mock status/system lines until this is wired to real events. */
const MOCK_STATUS: { text: string; tone: "good" | "bad" | "info" }[] = [
  { text: "Entered Safe Zone.", tone: "good" },
  { text: "Shield fully recharged.", tone: "good" },
  { text: "Level up! You are now level 3.", tone: "info" },
  { text: "Left Safe Zone — hostiles ahead.", tone: "bad" },
];

export function ChatWindow({ connection }: { connection: GameConnection }) {
  const chat = useGame((s) => s.chat);
  const chatOpen = useGame((s) => s.chatOpen);
  const abilities = useGame((s) => s.abilities);
  const set = useGame((s) => s.set);
  const [tab, setTab] = useState<Tab>("CHAT");
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [, force] = useState(0);

  // Opening chat (Enter) always brings the CHAT tab forward.
  useEffect(() => {
    if (chatOpen) {
      setTab("CHAT");
      inputRef.current?.focus();
    }
  }, [chatOpen]);

  // Tick buff timers on the status tab.
  useEffect(() => {
    if (tab !== "STATUS") return;
    const timer = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [tab]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (text) connection.send({ t: "Chat", d: { text } });
    setDraft("");
    set({ chatOpen: false });
    inputRef.current?.blur();
  }

  const now = performance.now();
  const buffs = (["Stim", "Overcharge"] as const).filter(
    (k) => abilities[k].activeUntil > now,
  );

  return (
    <div className={`chatwin${chatOpen ? " open" : ""}`}>
      <div className="chatwin-tabs">
        {TABS.map((t) => (
          <div
            key={t}
            className={`chatwin-tab${tab === t ? " active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t}
          </div>
        ))}
      </div>
      <div className="chatwin-body">
        {tab === "CHAT" && (
          <div className="chatwin-lines">
            {[...chat].reverse().map((line, i) => (
              <div key={i} className={`chat-line${line.system ? " system" : ""}`}>
                {!line.system && <span className="from">{line.from}: </span>}
                {line.text}
              </div>
            ))}
          </div>
        )}
        {tab === "COMBAT" && (
          <div className="chatwin-lines">
            {[...MOCK_COMBAT].reverse().map((line, i) => (
              <div key={i} className={`chat-line combat-${line.tone}`}>
                {line.text}
              </div>
            ))}
          </div>
        )}
        {tab === "STATUS" && (
          <>
            {buffs.length > 0 && (
              <div className="chatwin-buffs">
                {buffs.map((k) => (
                  <div key={k} className="buff-chip" title={k}>
                    <span className="buff-glyph">{k === "Stim" ? "✚" : "↯"}</span>
                    {k.toUpperCase()}{" "}
                    {Math.max(0, (abilities[k].activeUntil - now) / 1000).toFixed(1)}s
                  </div>
                ))}
              </div>
            )}
            <div className="chatwin-lines">
              {[...MOCK_STATUS].reverse().map((line, i) => (
                <div key={i} className={`chat-line status-${line.tone}`}>
                  {line.text}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {tab === "CHAT" && chatOpen && (
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
                // Escape spent on closing chat: don't let the relock/unlock
                // bounce read as an "open game menu" Escape (see CameraRig).
                cameraState.suppressMenuUntil = performance.now() + 1500;
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
