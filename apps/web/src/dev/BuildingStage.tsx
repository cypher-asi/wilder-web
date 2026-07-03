// Building Stage: staging area for prefab buildings assembled from kit tile
// modules. Dial in panel configuration against the real game render pipeline,
// then copy the config into building.ts / save presets on the lab server.
import { useCallback, useEffect, useMemo, useState } from "react";
import { BuildingPrefab, Registry, labApi } from "./labApi";
import { BuildingStageViewport } from "./BuildingStageViewport";
import {
  findStageModules,
  makeDefaultPrefabs,
  moduleToPanel,
  prefabToCode,
} from "./stagePrefabs";

const ARCHETYPES = ["0 · brick", "1 · dark brick", "2 · concrete", "3 · metal"];

let idCounter = 0;
function freshId(): string {
  return `prefab_${Date.now().toString(36)}_${idCounter++}`;
}

export function BuildingStage({
  registry,
  onToast,
}: {
  registry: Registry | null;
  onToast: (msg: string) => void;
}) {
  const [prefabs, setPrefabs] = useState<BuildingPrefab[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const modules = useMemo(() => findStageModules(registry), [registry]);

  // Load saved presets once; seed with generated defaults when none exist.
  // Seeding waits for the registry so defaults reflect the promoted kit.
  useEffect(() => {
    if (prefabs !== null || registry === null) return;
    let alive = true;
    labApi
      .buildings()
      .catch(() => [] as BuildingPrefab[])
      .then((saved) => {
        if (!alive) return;
        const list = saved.length > 0 ? saved : makeDefaultPrefabs(findStageModules(registry));
        setPrefabs(list);
        setSelectedId((cur) => cur ?? list[0]?.id ?? null);
      });
    return () => {
      alive = false;
    };
  }, [prefabs, registry]);

  const selected = prefabs?.find((p) => p.id === selectedId) ?? null;

  const update = useCallback(
    (fn: (p: BuildingPrefab) => BuildingPrefab) => {
      if (!selectedId) return;
      setPrefabs((list) => list?.map((p) => (p.id === selectedId ? fn(p) : p)) ?? list);
      setDirty(true);
    },
    [selectedId],
  );

  function addPrefab(base?: BuildingPrefab) {
    const src = base ?? makeDefaultPrefabs(modules)[0];
    const p: BuildingPrefab = {
      ...src,
      kit: { ...src.kit, panels: [...src.kit.panels] },
      id: freshId(),
      name: base ? `${base.name} copy` : "New building",
    };
    setPrefabs((list) => [...(list ?? []), p]);
    setSelectedId(p.id);
    setDirty(true);
  }

  function deleteSelected() {
    if (!selectedId) return;
    setPrefabs((list) => {
      const next = (list ?? []).filter((p) => p.id !== selectedId);
      setSelectedId(next[0]?.id ?? null);
      return next;
    });
    setDirty(true);
  }

  async function saveAll() {
    if (!prefabs) return;
    try {
      await labApi.saveBuildings(prefabs);
      setDirty(false);
      onToast(`Saved ${prefabs.length} building prefabs`);
    } catch (err) {
      onToast(`Save failed: ${(err as Error).message}`);
    }
  }

  function resetDefaults() {
    const defaults = makeDefaultPrefabs(modules);
    setPrefabs(defaults);
    setSelectedId(defaults[0]?.id ?? null);
    setDirty(true);
  }

  async function copyConfig() {
    if (!selected) return;
    await navigator.clipboard.writeText(prefabToCode(selected));
    onToast("Config copied to clipboard");
  }

  function togglePanel(assetId: string) {
    const mod = modules.find((m) => m.manifestId === assetId);
    update((p) => {
      const has = p.kit.panels.some((panel) => panel.assetId === assetId);
      const panels = has
        ? p.kit.panels.filter((panel) => panel.assetId !== assetId)
        : [...p.kit.panels, mod ? moduleToPanel(mod) : { assetId, h: 12 }];
      return { ...p, kit: { ...p.kit, panels } };
    });
  }

  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return (
    <div className="lab-body">
      <aside className="lab-browser">
        <div className="lab-filters stage-actions">
          <button className="lab-filter" onClick={() => addPrefab()}>
            + new
          </button>
          <button className="lab-filter" onClick={() => selected && addPrefab(selected)} disabled={!selected}>
            duplicate
          </button>
          <button className="lab-filter" onClick={deleteSelected} disabled={!selected}>
            delete
          </button>
          <button className="lab-filter" onClick={resetDefaults}>
            reset defaults
          </button>
          <button className={`lab-filter ${dirty ? "active" : ""}`} onClick={saveAll} disabled={!dirty}>
            save all
          </button>
        </div>
        <div className="lab-asset-list">
          {(prefabs ?? []).map((p) => (
            <button
              key={p.id}
              className={`lab-asset-card ${selectedId === p.id ? "active" : ""}`}
              onClick={() => setSelectedId(p.id)}
            >
              <div className="lab-asset-info">
                <div className="lab-asset-name">{p.name}</div>
                <div className="lab-asset-sub">
                  <span className="lab-asset-cat">
                    {p.tilesX}×{p.tilesZ} tiles · {p.stories} stories · {p.kit.panels.length} modules
                  </span>
                </div>
              </div>
            </button>
          ))}
          {prefabs === null && <div className="sk-empty">loading prefabs…</div>}
          {prefabs?.length === 0 && <div className="sk-empty">no prefabs — create one</div>}
        </div>
      </aside>

      <main className="lab-center">
        <div className="lab-viewport-bar">
          <span className="lab-viewport-label">
            {selected ? `${selected.name} — staged through the game building pipeline` : "no prefab selected"}
          </span>
        </div>
        <BuildingStageViewport prefab={selected} />
      </main>

      <aside className="lab-sidekick">
        <div className="sk-header">BUILDING STAGE</div>
        {!selected ? (
          <div className="sk-empty">select a prefab to edit its configuration</div>
        ) : (
          <>
            <div className="sk-section">
              <div className="sk-section-title">Prefab</div>
              <div className="sk-row">
                <span className="sk-label">name</span>
                <input
                  className="sk-input"
                  value={selected.name}
                  onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
                />
              </div>
            </div>

            <div className="sk-section">
              <div className="sk-section-title">Structure</div>
              <div className="sk-row">
                <span className="sk-label">footprint (tiles, 2 m)</span>
                <span className="stage-pair">
                  <input
                    className="sk-input stage-num"
                    type="number"
                    min={1}
                    value={selected.tilesX}
                    onChange={(e) => update((p) => ({ ...p, tilesX: num(e.target.value, p.tilesX) }))}
                  />
                  <input
                    className="sk-input stage-num"
                    type="number"
                    min={1}
                    value={selected.tilesZ}
                    onChange={(e) => update((p) => ({ ...p, tilesZ: num(e.target.value, p.tilesZ) }))}
                  />
                </span>
              </div>
              <div className="sk-row">
                <span className="sk-label">stories</span>
                <input
                  className="sk-input stage-num"
                  type="number"
                  min={1}
                  value={selected.stories}
                  onChange={(e) => update((p) => ({ ...p, stories: num(e.target.value, p.stories) }))}
                />
              </div>
              <div className="sk-row">
                <span className="sk-label">archetype</span>
                <select
                  className="sk-input"
                  value={selected.archetype}
                  onChange={(e) => update((p) => ({ ...p, archetype: Number(e.target.value) }))}
                >
                  {ARCHETYPES.map((label, i) => (
                    <option key={i} value={i}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sk-row">
                <span className="sk-label">style seed</span>
                <span className="stage-pair">
                  <input
                    className="sk-input stage-hex"
                    value={`0x${(selected.style >>> 0).toString(16)}`}
                    onChange={(e) =>
                      update((p) => ({ ...p, style: num(e.target.value, p.style) >>> 0 }))
                    }
                  />
                  <button
                    className="lab-filter"
                    onClick={() =>
                      update((p) => ({ ...p, style: (Math.random() * 0xffffffff) >>> 0 }))
                    }
                  >
                    reroll
                  </button>
                </span>
              </div>
            </div>

            <div className="sk-section">
              <div className="sk-section-title">Facade modules</div>
              {modules.length === 0 && (
                <div className="sk-empty">no promoted facade modules found in the registry</div>
              )}
              {modules.map((m) => {
                const checked = selected.kit.panels.some((panel) => panel.assetId === m.manifestId);
                return (
                  <label key={m.manifestId} className="stage-module">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePanel(m.manifestId)}
                    />
                    <span className="stage-module-name">{m.asset.name}</span>
                    <span className="stage-module-dims">
                      {m.width}×{m.height} m · {m.triangles} tris
                    </span>
                  </label>
                );
              })}
              {selected.kit.panels
                .filter((panel) => !modules.some((m) => m.manifestId === panel.assetId))
                .map((panel) => (
                  <label key={panel.assetId} className="stage-module">
                    <input type="checkbox" checked onChange={() => togglePanel(panel.assetId)} />
                    <span className="stage-module-name">{panel.assetId}</span>
                    <span className="stage-module-dims">h {panel.h} m (not in registry)</span>
                  </label>
                ))}
            </div>

            <div className="sk-section">
              <div className="sk-section-title">Panel tuning</div>
              <div className="sk-row">
                <span className="sk-label">module width (m)</span>
                <input
                  className="sk-input stage-num"
                  type="number"
                  step={0.5}
                  min={1}
                  value={selected.kit.moduleWidth}
                  onChange={(e) =>
                    update((p) => ({
                      ...p,
                      kit: { ...p.kit, moduleWidth: num(e.target.value, p.kit.moduleWidth) },
                    }))
                  }
                />
              </div>
              <div className="sk-row">
                <span className="sk-label">depth scale</span>
                <input
                  className="sk-input stage-num"
                  type="number"
                  step={0.05}
                  min={0.05}
                  max={1}
                  value={selected.kit.depthScale}
                  onChange={(e) =>
                    update((p) => ({
                      ...p,
                      kit: { ...p.kit, depthScale: num(e.target.value, p.kit.depthScale) },
                    }))
                  }
                />
              </div>
              <div className="sk-row">
                <span className="sk-label">wall z (m)</span>
                <input
                  className="sk-input stage-num"
                  type="number"
                  step={0.01}
                  value={selected.kit.wallZ}
                  onChange={(e) =>
                    update((p) => ({
                      ...p,
                      kit: { ...p.kit, wallZ: num(e.target.value, p.kit.wallZ) },
                    }))
                  }
                />
              </div>
              <div className="sk-row">
                <span className="sk-label">base height (m)</span>
                <input
                  className="sk-input stage-num"
                  type="number"
                  step={0.1}
                  min={0}
                  value={selected.kit.baseHeight}
                  onChange={(e) =>
                    update((p) => ({
                      ...p,
                      kit: { ...p.kit, baseHeight: num(e.target.value, p.kit.baseHeight) },
                    }))
                  }
                />
              </div>
              <div className="sk-row">
                <span className="sk-label">panels only</span>
                <input
                  type="checkbox"
                  checked={selected.kit.panelsOnly ?? false}
                  onChange={(e) =>
                    update((p) => ({ ...p, kit: { ...p.kit, panelsOnly: e.target.checked } }))
                  }
                />
              </div>
              <div className="sk-row">
                <span className="sk-label">force kit tower</span>
                <input
                  type="checkbox"
                  checked={selected.kit.forceKitTower ?? false}
                  onChange={(e) =>
                    update((p) => ({ ...p, kit: { ...p.kit, forceKitTower: e.target.checked } }))
                  }
                />
              </div>
            </div>

            <div className="sk-section">
              <div className="sk-section-title">Export</div>
              <button className="lab-filter stage-copy" onClick={copyConfig}>
                copy config for building.ts
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
