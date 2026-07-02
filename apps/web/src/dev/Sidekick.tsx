// Right panel: everything known about the selected asset plus the manual
// game-ready pipeline controls (recipe editor, optimize, promote). Derivatives
// (one per pipeline run) are listed here and selectable into the viewport.
import { useEffect, useState } from "react";
import { LabAsset, Recipe, thumbUrl, variantLabel } from "./labApi";

function fmtBytes(n?: number): string {
  if (!n && n !== 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDate(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="sk-row">
      <span className="sk-label">{label}</span>
      <span className="sk-value">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="sk-section">
      <div className="sk-section-title">{title}</div>
      {children}
    </div>
  );
}

export function Sidekick({
  asset,
  presets,
  busy,
  view,
  onSelectView,
  onImport,
  onOptimize,
  onPromote,
}: {
  asset: LabAsset | null;
  presets: Record<string, Recipe>;
  busy: boolean;
  /** "original" or a derivative id — mirrors what's in the viewport. */
  view: string;
  onSelectView: (view: string) => void;
  onImport: (id: string) => void;
  onOptimize: (id: string, recipe: Partial<Recipe>) => void;
  onPromote: (id: string, variant: string) => void;
}) {
  const [recipe, setRecipe] = useState<Partial<Recipe>>({});

  // Reset the recipe editor when switching assets: last-used recipe, else the
  // preset for the asset's guessed category.
  useEffect(() => {
    if (!asset) return;
    setRecipe(asset.recipe ?? presets[asset.category] ?? { category: asset.category });
  }, [asset?.id, asset?.recipe, presets]);

  if (!asset) {
    return (
      <aside className="lab-sidekick">
        <div className="sk-header">SIDEKICK</div>
        <div className="sk-empty">No asset selected</div>
      </aside>
    );
  }

  const meta = asset.meta;
  const variants = asset.variants ?? [];
  const viewedVariant = variants.find((v) => v.id === view) ?? null;
  const report = viewedVariant?.report ?? null;

  function setField<K extends keyof Recipe>(key: K, value: Recipe[K]) {
    setRecipe((r) => ({ ...r, [key]: value }));
  }

  function applyPreset(category: string) {
    setRecipe({ ...presets[category], category });
  }

  return (
    <aside className="lab-sidekick">
      <div className="sk-header">SIDEKICK</div>

      <Section title="Identity">
        <Row label="Name" value={asset.name} />
        <Row label="Kit" value={asset.kit} />
        <Row label="Source" value={<span title={asset.sourcePath}>{asset.sourcePath}</span>} />
        <Row label="Source size" value={fmtBytes(asset.sourceSizeBytes)} />
        <Row label="Status" value={<span className={`sk-status sk-status-${asset.status}`}>{asset.status}</span>} />
        <Row label="Discovered" value={fmtDate(asset.discoveredAt)} />
        <Row label="Imported" value={fmtDate(asset.importedAt)} />
        <Row label="Optimized" value={fmtDate(asset.optimizedAt)} />
        {asset.promotedAt && <Row label="Promoted" value={fmtDate(asset.promotedAt)} />}
        {asset.manifestId && <Row label="Manifest id" value={asset.manifestId} />}
      </Section>

      {asset.error && <div className="sk-error">{asset.error}</div>}

      <button
        className={asset.status === "raw" ? "btn btn-primary" : "btn btn-ghost"}
        disabled={busy || asset.status === "importing" || asset.status === "optimizing"}
        onClick={() => onImport(asset.id)}
      >
        {asset.status === "importing"
          ? "IMPORTING…"
          : asset.status === "raw"
            ? "IMPORT ASSET"
            : "RE-IMPORT (REFRESH TEXTURES/META)"}
      </button>

      {meta && (
        <>
          <Section title="Geometry">
            <Row
              label="Dimensions"
              value={`${meta.dimensions_m.map((v) => v.toFixed(2)).join(" × ")} m`}
            />
            <Row label="Triangles" value={meta.triangles.toLocaleString()} />
            <Row label="Vertices" value={meta.vertices.toLocaleString()} />
            <Row label="Objects" value={meta.objects} />
            <Row label="Material slots" value={meta.material_count} />
            <Row label="Preview GLB" value={fmtBytes(meta.preview_glb_bytes)} />
          </Section>

          <Section title="Flags">
            <Row label="Transparency" value={meta.has_transparency ? "yes" : "no"} />
            <Row label="Emissive" value={meta.has_emissive ? "yes" : "no"} />
            <Row label="Animation" value={meta.has_animation ? "yes" : "no"} />
          </Section>

          <Section title={`Materials (${meta.materials.length})`}>
            {meta.materials.map((m) => {
              const roles = Object.keys(m.textures ?? {}).filter((k) => k !== "key");
              return (
                <Row
                  key={m.name}
                  label={m.name}
                  value={
                    roles.length > 0 ? (
                      roles.join(" · ")
                    ) : (
                      <span className="sk-fail">no textures matched</span>
                    )
                  }
                />
              );
            })}
          </Section>

          <Section title={`Textures (${meta.textures.length})`}>
            {meta.textures.length === 0 && <div className="sk-empty">none detected</div>}
            {meta.textures.map((t) => (
              <Row key={t.file} label={`${t.width}×${t.height}`} value={t.file} />
            ))}
          </Section>

          <Section title="Thumbnails">
            <div className="sk-thumbs">
              {[0, 1, 2, 3].map((i) => (
                <img key={i} src={thumbUrl(asset, i)} alt="" loading="lazy" />
              ))}
            </div>
          </Section>

          <Section title="Game-Ready Recipe">
            <div className="sk-row">
              <span className="sk-label">Category</span>
              <select
                className="sk-input"
                value={recipe.category ?? asset.category}
                onChange={(e) => applyPreset(e.target.value)}
              >
                {Object.keys(presets).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="sk-row">
              <span className="sk-label">Decimate ratio</span>
              <input
                className="sk-input"
                type="number"
                step={0.05}
                min={0.02}
                max={1}
                value={recipe.decimate_ratio ?? 1}
                onChange={(e) => setField("decimate_ratio", Number(e.target.value))}
              />
            </div>
            <div className="sk-row">
              <span className="sk-label">Max texture px</span>
              <input
                className="sk-input"
                type="number"
                step={128}
                min={64}
                max={4096}
                value={recipe.texture_max_size ?? 1024}
                onChange={(e) => setField("texture_max_size", Number(e.target.value))}
              />
            </div>
            <div className="sk-row">
              <span className="sk-label">Triangle budget</span>
              <input
                className="sk-input"
                type="number"
                step={1000}
                min={100}
                value={recipe.max_triangles ?? 50000}
                onChange={(e) => setField("max_triangles", Number(e.target.value))}
              />
            </div>
            <button
              className="btn btn-primary"
              disabled={busy || asset.status === "optimizing"}
              onClick={() => onOptimize(asset.id, recipe)}
            >
              {asset.status === "optimizing"
                ? "OPTIMIZING…"
                : `RUN PIPELINE → NEW DERIVATIVE (v${variants.length + 1})`}
            </button>
          </Section>

          <Section title={`Derivatives (${variants.length})`}>
            {variants.length === 0 && (
              <div className="sk-empty">none yet — run the pipeline to create v1</div>
            )}
            {variants.map((v) => (
              <button
                key={v.id}
                className={`sk-variant ${view === v.id ? "active" : ""}`}
                onClick={() => onSelectView(view === v.id ? "original" : v.id)}
              >
                <span className={v.passed ? "sk-pass" : "sk-fail"}>{v.passed ? "✓" : "✗"}</span>
                <span className="sk-variant-label">{variantLabel(v)}</span>
                <span className="sk-variant-size">{fmtBytes(v.report.after.fileBytes)}</span>
                {asset.promotedVariant === v.id && <span className="sk-variant-star">★</span>}
              </button>
            ))}
          </Section>
        </>
      )}

      {viewedVariant && report && (
        <Section title={`${viewedVariant.id} Report — ${report.passed ? "PASSED" : "FAILED"}`}>
          <Row
            label="Triangles"
            value={`${report.before.triangles.toLocaleString()} → ${report.after.triangles.toLocaleString()}`}
          />
          <Row label="Materials" value={`${report.before.materials} → ${report.after.materials}`} />
          <Row
            label="File size"
            value={`${fmtBytes(report.before.fileBytes)} → ${fmtBytes(report.after.fileBytes)}`}
          />
          <Row
            label="Max texture"
            value={`${report.before.maxTextureSize}px → ${report.after.maxTextureSize}px`}
          />
          {report.checks.map((c) => (
            <Row
              key={c.name}
              label={c.name}
              value={
                <span className={c.pass ? "sk-pass" : "sk-fail"}>
                  {c.pass ? "✓" : "✗"} {c.detail}
                </span>
              }
            />
          ))}
        </Section>
      )}

      {viewedVariant && viewedVariant.passed && (
        <button
          className="btn btn-dev"
          disabled={busy}
          onClick={() => onPromote(asset.id, viewedVariant.id)}
        >
          {asset.promotedVariant === viewedVariant.id
            ? `RE-PROMOTE ${viewedVariant.id} TO GAME`
            : `PROMOTE ${viewedVariant.id} TO GAME`}
        </button>
      )}
    </aside>
  );
}
