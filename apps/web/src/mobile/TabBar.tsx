import { useGame } from "../state/game";
import type { MobileTab } from "../state/game";

interface TabDef {
  id: MobileTab;
  label: string;
  icon: React.ReactNode;
}

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const TABS: TabDef[] = [
  {
    id: "agents",
    label: "Agents",
    icon: (
      <svg viewBox="0 0 24 24" {...STROKE}>
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
        <circle cx="17" cy="9.5" r="2.4" />
        <path d="M15.5 14.4c2.8 0 5 1.8 5 4.6" />
      </svg>
    ),
  },
  {
    id: "watch",
    label: "Watch",
    icon: (
      <svg viewBox="0 0 24 24" {...STROKE}>
        <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
        <circle cx="12" cy="12" r="2.6" />
      </svg>
    ),
  },
  {
    id: "map",
    label: "Map",
    icon: (
      <svg viewBox="0 0 24 24" {...STROKE}>
        <path d="M3.5 6.5 9 4.5l6 2 5.5-2v13l-5.5 2-6-2-5.5 2v-13Z" />
        <path d="M9 4.5v13M15 6.5v13" />
      </svg>
    ),
  },
  {
    id: "economy",
    label: "Economy",
    icon: (
      <svg viewBox="0 0 24 24" {...STROKE}>
        <path d="M3.5 19.5h17" />
        <path d="M4.5 15.5 9 11l3.5 3 7-7.5" />
        <path d="M15.5 6.5h4v4" />
      </svg>
    ),
  },
  {
    id: "trade",
    label: "Trade",
    icon: (
      <svg viewBox="0 0 24 24" {...STROKE}>
        <path d="M4 8.5h13l-3-3M20 15.5H7l3 3" />
      </svg>
    ),
  },
];

export function TabBar() {
  const active = useGame((s) => s.mobileTab);
  const setMobileTab = useGame((s) => s.setMobileTab);
  return (
    <nav className="m-tabbar">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`m-tab${active === tab.id ? " m-tab-active" : ""}`}
          onClick={() => setMobileTab(tab.id)}
        >
          <span className="m-tab-icon">{tab.icon}</span>
          <span className="m-tab-label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
