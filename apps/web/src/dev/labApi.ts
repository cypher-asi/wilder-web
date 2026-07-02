// Client for the Asset Lab dev server (tools/asset-lab/server.mjs, proxied at /lab).

export type AssetStatus =
  | "raw"
  | "importing"
  | "imported"
  | "optimizing"
  | "gameready"
  | "promoted";

export interface TextureInfo {
  file: string;
  width: number;
  height: number;
}

export interface MaterialInfo {
  name: string;
  textures: Record<string, string>;
}

export interface AssetMeta {
  name: string;
  source_fbx: string;
  dimensions_m: [number, number, number];
  bbox_min: [number, number, number];
  bbox_max: [number, number, number];
  triangles: number;
  vertices: number;
  objects: number;
  materials: MaterialInfo[];
  material_count: number;
  textures: TextureInfo[];
  has_transparency: boolean;
  has_emissive: boolean;
  has_animation: boolean;
  preview_glb_bytes: number;
}

export interface Recipe {
  category: string;
  decimate_ratio: number;
  weld_distance: number;
  texture_max_size: number;
  normalize_pivot: string;
  max_triangles: number;
}

export interface ReportStats {
  triangles: number;
  materials: number;
  meshes: number;
  textures: number;
  maxTextureSize: number;
  dimensions: number[];
  fileBytes: number;
}

export interface ReportSummary {
  passed: boolean;
  before: ReportStats;
  after: ReportStats;
  checks: { name: string; pass: boolean; detail: string }[];
}

export interface LabAsset {
  id: string;
  name: string;
  kit: string;
  sourcePath: string;
  sourceSizeBytes: number;
  category: string;
  status: AssetStatus;
  discoveredAt?: string;
  importedAt?: string;
  optimizedAt?: string;
  promotedAt?: string;
  manifestId?: string;
  meta?: AssetMeta;
  recipe?: Recipe;
  report?: ReportSummary;
  error?: string | null;
}

export interface Registry {
  version: number;
  updatedAt: string | null;
  assets: Record<string, LabAsset>;
}

export interface LabJob {
  assetId: string;
  type: "import" | "optimize";
  startedAt: string;
  finishedAt?: string;
  done: boolean;
  error: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const labApi = {
  registry: () => request<Registry>("/lab/assets"),
  presets: () => request<Record<string, Recipe>>("/lab/presets"),
  jobs: () => request<LabJob[]>("/lab/jobs"),
  import: (id: string) => request<LabJob>(`/lab/import/${id}`, { method: "POST" }),
  optimize: (id: string, recipe: Partial<Recipe>) =>
    request<LabJob>(`/lab/optimize/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(recipe),
    }),
  promote: (id: string) => request<LabAsset>(`/lab/promote/${id}`, { method: "POST" }),
};

export function thumbUrl(asset: LabAsset, index = 0): string {
  return `/content/imported/${asset.kit}/${asset.id}/thumbs/${String(index).padStart(2, "0")}.png`;
}

export function previewGlbUrl(asset: LabAsset): string {
  return `/content/imported/${asset.kit}/${asset.id}/preview.glb`;
}

export function gameReadyGlbUrl(asset: LabAsset): string {
  return `/content/gameready/${asset.kit}/${asset.id}/${asset.id}.glb`;
}
