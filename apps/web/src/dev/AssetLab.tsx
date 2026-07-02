// Asset Lab: dev-only asset inspector + game-ready pipeline frontend.
// Left: browsable registry. Center: 3D viewport. Right: Sidekick panel.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../state/session";
import { AssetViewport } from "./AssetViewport";
import { Sidekick } from "./Sidekick";
import {
  AssetStatus,
  LabAsset,
  Recipe,
  Registry,
  gameReadyGlbUrl,
  labApi,
  previewGlbUrl,
  thumbUrl,
} from "./labApi";
import "./assetlab.css";

const STATUS_FILTERS: ("all" | AssetStatus)[] = [
  "all",
  "raw",
  "imported",
  "gameready",
  "promoted",
];

export function AssetLab() {
  const exitAssetLab = useSession((s) => s.exitAssetLab);
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [presets, setPresets] = useState<Record<string, Recipe>>({});
  const [serverDown, setServerDown] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | AssetStatus>("all");
  const [viewMode, setViewMode] = useState<"preview" | "gameready">("preview");
  const [wireframe, setWireframe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const pollBusy = useRef(false);

  const refresh = useCallback(async () => {
    if (pollBusy.current) return;
    pollBusy.current = true;
    try {
      const reg = await labApi.registry();
      setRegistry(reg);
      setServerDown(false);
    } catch {
      setServerDown(true);
    } finally {
      pollBusy.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    labApi.presets().then(setPresets).catch(() => {});
    const timer = setInterval(refresh, 2500);
    return () => clearInterval(timer);
  }, [refresh]);

  const assets = useMemo(() => {
    const all = Object.values(registry?.assets ?? {});
    const q = search.trim().toLowerCase();
    return all
      .filter((a) => statusFilter === "all" || a.status === statusFilter)
      .filter((a) => !q || a.id.includes(q) || a.name.toLowerCase().includes(q))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [registry, search, statusFilter]);

  const selected: LabAsset | null =
    (selectedId && registry?.assets[selectedId]) || null;

  const counts = useMemo(() => {
    const all = Object.values(registry?.assets ?? {});
    const by: Record<string, number> = { all: all.length };
    for (const a of all) by[a.status] = (by[a.status] ?? 0) + 1;
    return by;
  }, [registry]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  async function runAction(action: () => Promise<unknown>, label: string) {
    setBusy(true);
    try {
      await action();
      showToast(`${label} started`);
    } catch (err) {
      showToast(`${label} failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      refresh();
    }
  }

  const viewportUrl = useMemo(() => {
    if (!selected) return null;
    if (viewMode === "gameready" && (selected.status === "gameready" || selected.status === "promoted")) {
      return gameReadyGlbUrl(selected);
    }
    if (selected.status === "raw" || selected.status === "importing") return null;
    return previewGlbUrl(selected);
  }, [selected, viewMode]);

  return (
    <div className="lab-root">
      <header className="lab-header">
        <span className="lab-title">WILDER // ASSET LAB</span>
        <span className="lab-header-info">
          {registry
            ? `${counts.all} assets · ${counts.imported ?? 0} imported · ${counts.gameready ?? 0} game-ready · ${counts.promoted ?? 0} promoted`
            : "loading registry…"}
        </span>
        {serverDown && (
          <span className="lab-server-down">lab server offline — run `npm run lab`</span>
        )}
        <button className="lab-exit" onClick={exitAssetLab}>
          ← BACK TO LOGIN
        </button>
      </header>

      <div className="lab-body">
        <aside className="lab-browser">
          <input
            className="field lab-search"
            placeholder="Search assets…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="lab-filters">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f}
                className={`lab-filter ${statusFilter === f ? "active" : ""}`}
                onClick={() => setStatusFilter(f)}
              >
                {f} {counts[f] != null ? `(${counts[f]})` : "(0)"}
              </button>
            ))}
          </div>
          <div className="lab-asset-list">
            {assets.map((a) => (
              <button
                key={a.id}
                className={`lab-asset-card ${selectedId === a.id ? "active" : ""}`}
                onClick={() => {
                  setSelectedId(a.id);
                  setViewMode(
                    a.status === "gameready" || a.status === "promoted" ? "gameready" : "preview",
                  );
                }}
              >
                {a.status !== "raw" && a.status !== "importing" ? (
                  <img className="lab-asset-thumb" src={thumbUrl(a)} alt="" loading="lazy" />
                ) : (
                  <div className="lab-asset-thumb lab-asset-thumb-empty">FBX</div>
                )}
                <div className="lab-asset-info">
                  <div className="lab-asset-name">{a.name}</div>
                  <div className="lab-asset-sub">
                    <span className={`sk-status sk-status-${a.status}`}>{a.status}</span>
                    <span className="lab-asset-cat">{a.category}</span>
                  </div>
                </div>
              </button>
            ))}
            {assets.length === 0 && <div className="sk-empty">no assets match</div>}
          </div>
        </aside>

        <main className="lab-center">
          <div className="lab-viewport-bar">
            <div className="lab-viewport-toggles">
              <button
                className={`lab-filter ${viewMode === "preview" ? "active" : ""}`}
                onClick={() => setViewMode("preview")}
                disabled={!selected || selected.status === "raw"}
              >
                imported
              </button>
              <button
                className={`lab-filter ${viewMode === "gameready" ? "active" : ""}`}
                onClick={() => setViewMode("gameready")}
                disabled={!selected || (selected.status !== "gameready" && selected.status !== "promoted")}
              >
                game-ready
              </button>
              <button
                className={`lab-filter ${wireframe ? "active" : ""}`}
                onClick={() => setWireframe((w) => !w)}
              >
                wireframe
              </button>
            </div>
            {selected && <span className="lab-viewport-label">{selected.name}</span>}
          </div>
          <AssetViewport url={viewportUrl} wireframe={wireframe} />
        </main>

        <Sidekick
          asset={selected}
          presets={presets}
          busy={busy}
          onImport={(id) => runAction(() => labApi.import(id), "Import")}
          onOptimize={(id, recipe) => runAction(() => labApi.optimize(id, recipe), "Optimize")}
          onPromote={(id) =>
            runAction(async () => {
              await labApi.promote(id);
              showToast("Promoted into game manifest");
            }, "Promote")
          }
        />
      </div>

      {toast && <div className="lab-toast">{toast}</div>}
    </div>
  );
}
