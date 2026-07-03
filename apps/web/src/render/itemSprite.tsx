// Rasterizes the inventory SVG glyphs (ui/ItemIcon.tsx) into white-tinted
// canvas textures so loot crates can float the icon of their contents in the
// 3D world. Textures are cached per item kind and drawn asynchronously when
// the SVG image decodes (the texture starts blank and flips needsUpdate).

import { renderToStaticMarkup } from "react-dom/server";
import * as THREE from "three";
import { ItemKind } from "../net/protocol";
import { CATEGORY_TICK, GLYPHS, ITEM_INFO } from "../ui/ItemIcon";

const SPRITE_PX = 128;
const textureCache = new Map<ItemKind, THREE.CanvasTexture>();

/**
 * White silhouette texture of an item's inventory glyph. The glyph's steel
 * fills are brightened to white while its dark cutout details are kept, so
 * the icon still reads as the item (medkit cross, circuit traces, ...).
 */
export function itemSpriteTexture(kind: ItemKind): THREE.CanvasTexture {
  const cached = textureCache.get(kind);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = SPRITE_PX;
  canvas.height = SPRITE_PX;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(kind, texture);

  const glyph = GLYPHS[kind];
  if (!glyph) return texture;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" ` +
    `width="${SPRITE_PX}" height="${SPRITE_PX}">` +
    renderToStaticMarkup(glyph) +
    `</svg>`;
  const image = new Image();
  image.onload = () => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, SPRITE_PX, SPRITE_PX);
    ctx.drawImage(image, 0, 0, SPRITE_PX, SPRITE_PX);
    // Push the light steel fills to pure white; the dark detail fills stay
    // dark enough to survive the lighten pass, keeping the icon readable.
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.55;
    ctx.drawImage(canvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    texture.needsUpdate = true;
  };
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return texture;
}

const materialCache = new Map<ItemKind, THREE.SpriteMaterial>();

/** Cached sprite material for an item glyph (shared across all loot crates
 * holding the same kind — crates never tint or fade these individually). */
export function itemSpriteMaterial(kind: ItemKind): THREE.SpriteMaterial {
  const cached = materialCache.get(kind);
  if (cached) return cached;
  const material = new THREE.SpriteMaterial({
    map: itemSpriteTexture(kind),
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  materialCache.set(kind, material);
  return material;
}

const tintedMaterialCache = new Map<ItemKind, THREE.SpriteMaterial>();

/**
 * Loot-crate topper material tinted by the item's category color (ammo amber,
 * currency green, resources blue, ...). The white silhouette texture is
 * multiplied by the category color so a floating crate icon reads its type -
 * and ammo boxes stand apart from regular loot - at a glance.
 */
export function itemSpriteMaterialTinted(kind: ItemKind): THREE.SpriteMaterial {
  const cached = tintedMaterialCache.get(kind);
  if (cached) return cached;
  const tick = CATEGORY_TICK[ITEM_INFO[kind]?.category];
  const material = new THREE.SpriteMaterial({
    map: itemSpriteTexture(kind),
    color: new THREE.Color(tick ?? "#ffffff"),
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  tintedMaterialCache.set(kind, material);
  return material;
}
