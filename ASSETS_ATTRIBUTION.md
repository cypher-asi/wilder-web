# Asset Attribution

All bundled assets are CC0 (public domain) unless noted. Thank you to these creators.

## 3D Models

| Asset | Source | License |
|---|---|---|
| `assets/models/character.glb` (Rogue Hooded, rigged + animated) | [KayKit Character Pack: Adventurers](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0) by Kay Lousberg | CC0 |
| `assets/models/streetlight|bench|trash_A|firehydrant|dumpster|car_*|trafficlight_A|watertower|box_A|bush` (+ `.bin`, `citybits_texture.png`) | [KayKit City Builder Bits](https://github.com/KayKit-Game-Assets/KayKit-City-Builder-Bits-1.0) by Kay Lousberg | CC0 |
| `assets/models/megakit/*` (AC unit, bollard, drain, manhole, planter, doors + shared textures, downscaled to 1K) | [Downtown City MegaKit](https://quaternius.com/packs/downtowncitymegakit.html) by Quaternius | CC0 |

## PBR Textures

All texture sets from [ambientCG](https://ambientcg.com) by Lennart Demes, CC0.
Each folder under `assets/textures/` holds `color.jpg`, `normal.jpg` (OpenGL),
and `roughness.jpg` from the 1K-JPG download of the listed material.

| Folder | ambientCG material |
|---|---|
| `asphalt` | Asphalt025C |
| `sidewalk` | PavingStones128 |
| `concrete` | Concrete034 |
| `concrete_panel` | Concrete046 |
| `pavers` | PavingStones070 |
| `grass` | Grass004 |
| `brick_red` | Bricks097 |
| `brick_dark` | Bricks075A |
| `brick_painted` | PaintedBricks001 |
| `metal_panel` | MetalPlates006 |
| `corrugated` | CorrugatedSteel005 |

## Audio

| Asset | Source | License |
|---|---|---|
| `assets/audio/footsteps.ogg`, `pickup.ogg`, `ui_click.ogg` | [Kenney Starter Kit 3D Platformer](https://github.com/KenneyNL/Starter-Kit-3D-Platformer) by Kenney | CC0 |
| `assets/audio/shoot.ogg`, `hit.ogg`, `death.ogg` | [Kenney Starter Kit FPS](https://github.com/KenneyNL/Starter-Kit-FPS) by Kenney | CC0 |

Rain/city ambience is synthesized at runtime with Web Audio (no asset file).

## Notes

- Building facades, ground, and several props are procedurally generated in-engine.
- When commissioned art replaces any of the above, update `assets/manifest.json`
  and this file together.
