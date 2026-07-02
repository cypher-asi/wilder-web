"""Headless Blender import worker for the Asset Lab.

Imports one FBX, wires up PBR textures by naming convention, extracts
metadata, renders turntable thumbnails and exports a preview GLB.

Usage:
  blender -b --factory-startup -P import_asset.py -- \
      --fbx <file.fbx> --textures-dir <dir> --out-dir <dir> --name <AssetName>

Outputs in --out-dir:
  preview.glb, thumbs/00.png .. 03.png, meta.json
"""

import argparse
import json
import math
import os
import re
import sys

import bpy
from mathutils import Vector

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--fbx", required=True)
parser.add_argument("--textures-dir", required=True)
parser.add_argument("--out-dir", required=True)
parser.add_argument("--name", required=True)
parser.add_argument("--thumb-size", type=int, default=512)
args = parser.parse_args(argv)

os.makedirs(args.out_dir, exist_ok=True)
thumbs_dir = os.path.join(args.out_dir, "thumbs")
os.makedirs(thumbs_dir, exist_ok=True)

# ---------------------------------------------------------------------------
# Clean scene + import
# ---------------------------------------------------------------------------

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=args.fbx)

# Unreal packs ship collision primitives as UCX_/UBX_/USP_/UCP_ prefixed
# meshes with no material. Strip them from previews/exports but record the
# count; the game-ready pipeline can regenerate collision later.
COLLISION_PREFIXES = ("ucx_", "ubx_", "usp_", "ucp_")
collision_count = 0
for obj in list(bpy.data.objects):
    if obj.type == "MESH" and obj.name.lower().startswith(COLLISION_PREFIXES):
        collision_count += 1
        bpy.data.objects.remove(obj, do_unlink=True)

mesh_objects = [o for o in bpy.data.objects if o.type == "MESH"]
if not mesh_objects:
    print("ASSETLAB_ERROR: no mesh objects in FBX")
    sys.exit(2)

# Apply transforms so measurements and exports are in world space.
bpy.ops.object.select_all(action="DESELECT")
for obj in bpy.data.objects:
    obj.select_set(True)
if bpy.data.objects:
    bpy.context.view_layer.objects.active = mesh_objects[0]
    try:
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    except RuntimeError:
        pass  # linked/multi-user data; measurements still work

# ---------------------------------------------------------------------------
# Texture hookup by naming convention (Unreal-style packs):
#   T_<Key>_B|Base|BaseColor|D|ALB|A  -> base color
#   T_<Key>_N|Normal                  -> normal map
#   T_<Key>_ORM                       -> occlusion(R) roughness(G) metallic(B)
#   T_<Key>_E|EM|Emissive             -> emissive
#   T_<Key>_OP                        -> opacity/alpha
# ---------------------------------------------------------------------------

SUFFIX_ROLES = {
    "b": "base", "base": "base", "basecolor": "base", "d": "base", "alb": "base", "a": "base",
    "a01": "base", "a02": "base",
    "n": "normal", "normal": "normal", "nrm": "normal",
    "orm": "orm",
    "r": "roughness", "roughness": "roughness",
    "e": "emissive", "em": "emissive", "emissive": "emissive",
    "op": "opacity",
}

# Kit-specific texture-set aliases where names simply don't correspond
# (curated by hand as exceptions surface in the Asset Lab).
KIT_ALIASES = {
    "3dbillboard": "3dsigns01",
    "roadsides": "roads_sides",
}


def index_textures(tex_dir):
    """Map lowercase key -> {role -> filepath}."""
    index = {}
    if not os.path.isdir(tex_dir):
        return index
    for fname in os.listdir(tex_dir):
        stem, ext = os.path.splitext(fname)
        if ext.lower() not in (".png", ".jpg", ".jpeg", ".tga"):
            continue
        m = re.match(r"^t_(.+)_([a-z0-9]+)$", stem.lower())
        if not m:
            continue
        key, suffix = m.group(1), m.group(2)
        role = SUFFIX_ROLES.get(suffix)
        if role:
            index.setdefault(key, {})[role] = os.path.join(tex_dir, fname)
    return index


def texture_key_candidates(mat_name, asset_name):
    """Possible texture keys for a material/asset name."""
    out = []
    for raw in (mat_name, asset_name):
        n = raw.lower()
        n = re.sub(r"\.\d+$", "", n)          # Blender duplicate suffix ".001"
        n = re.sub(r"^(m|mi|mm|mat|sm)_", "", n)  # material/mesh prefixes
        out.append(n)
        out.append(re.sub(r"_?(inst|mat|material)$", "", n))
    for c in list(out):
        alias = KIT_ALIASES.get(c) or KIT_ALIASES.get(re.sub(r"\d+$", "", c.replace("_", "")))
        if alias:
            out.insert(0, alias)
    seen, uniq = set(), []
    for c in out:
        if c and c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq


TEX_INDEX = index_textures(args.textures_dir)


def norm_key(key):
    """Collapse naming-convention noise: underscores and trailing digit runs
    (MI_RoadsAsphalt02 vs T_Roads_Asphalt, MI_Slums_Concrete01 vs T_SlumsConcrete)."""
    return re.sub(r"\d+$", "", key.replace("_", ""))


def find_texture_set(mat_name, key_hints=()):
    candidates = [c for c in list(key_hints) + texture_key_candidates(mat_name, args.name) if c]
    # 1. Exact key match.
    for key in candidates:
        if key in TEX_INDEX:
            return key, TEX_INDEX[key]
    # 2. Normalized match (ignore underscores + trailing digits on both sides).
    norm_index = {}
    for k in sorted(TEX_INDEX):
        norm_index.setdefault(norm_key(k), k)
    for key in candidates:
        hit = norm_index.get(norm_key(key))
        if hit:
            return hit, TEX_INDEX[hit]
    # 3. Loose prefix fallback on normalized keys (e.g. material "aircon" vs
    #    key "airconditioner01"). Deterministic: shortest match, alphabetical.
    for key in candidates:
        nk = norm_key(key)
        if len(nk) < 4:
            continue  # too short to be a meaningful prefix
        hits = sorted(
            (k for k in TEX_INDEX if norm_key(k).startswith(nk) or nk.startswith(norm_key(k))),
            key=lambda k: (len(k), k),
        )
        if hits:
            return hits[0], TEX_INDEX[hits[0]]
    return None, None


def load_image(path):
    img = bpy.data.images.load(path, check_existing=True)
    return img


def index_dir_basenames(tex_dir):
    """Map lowercase filename stem -> filepath for every image in the kit."""
    idx = {}
    if not os.path.isdir(tex_dir):
        return idx
    for fname in os.listdir(tex_dir):
        stem, ext = os.path.splitext(fname)
        if ext.lower() in (".png", ".jpg", ".jpeg", ".tga"):
            idx[stem.lower()] = os.path.join(tex_dir, fname)
    return idx


BASENAME_INDEX = index_dir_basenames(args.textures_dir)


def rescue_fbx_references(mat):
    """FBX materials embed texture nodes pointing at the vendor's machine
    (e.g. C:\\Program Files\\Moderncity\\...\\T_airConditioner01_Base.jpg).
    The kit usually ships the same file (often as .PNG) under Textures/, so
    repoint broken nodes by filename stem — the FBX's own wiring is a more
    reliable signal than guessing from material names.

    Returns (roles, keys): roles maps role -> rescued basename for the meta,
    keys are texture-set keys (e.g. "airconditioner01") usable as hints."""
    roles, keys = {}, []
    if not mat.use_nodes:
        return roles, keys
    for node in mat.node_tree.nodes:
        if node.type != "TEX_IMAGE" or node.image is None:
            continue
        if os.path.exists(bpy.path.abspath(node.image.filepath)):
            continue
        stem = os.path.splitext(os.path.basename(node.image.filepath.replace("\\", "/")))[0].lower()
        found = BASENAME_INDEX.get(stem)
        if not found:
            continue
        node.image = load_image(found)
        m = re.match(r"^t_(.+)_([a-z0-9]+)$", stem)
        if m:
            keys.append(m.group(1))
            role = SUFFIX_ROLES.get(m.group(2))
            if role:
                roles[role] = os.path.basename(found)
                if role in ("normal", "orm", "opacity"):
                    node.image.colorspace_settings.name = "Non-Color"
    return roles, keys


def strip_broken_image_nodes(mat):
    """Remove any texture nodes that still don't resolve after rescue."""
    if not mat.use_nodes:
        return
    for node in list(mat.node_tree.nodes):
        if node.type != "TEX_IMAGE":
            continue
        img = node.image
        if img is None or not os.path.exists(bpy.path.abspath(img.filepath)):
            mat.node_tree.nodes.remove(node)


def wire_material(mat, key_hints=(), skip_roles=frozenset()):
    """Attach convention-named textures to a Principled BSDF material.
    Roles in skip_roles were already wired from the FBX's own references."""
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        return None

    key, tex_set = find_texture_set(mat.name, key_hints)
    if not tex_set:
        return None

    tex_set = {role: path for role, path in tex_set.items() if role not in skip_roles}
    used = {"key": key}

    if "base" in tex_set:
        node = nodes.new("ShaderNodeTexImage")
        node.image = load_image(tex_set["base"])
        links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
        used["base"] = os.path.basename(tex_set["base"])

    if "normal" in tex_set:
        img_node = nodes.new("ShaderNodeTexImage")
        img_node.image = load_image(tex_set["normal"])
        img_node.image.colorspace_settings.name = "Non-Color"
        nrm = nodes.new("ShaderNodeNormalMap")
        links.new(img_node.outputs["Color"], nrm.inputs["Color"])
        links.new(nrm.outputs["Normal"], bsdf.inputs["Normal"])
        used["normal"] = os.path.basename(tex_set["normal"])

    if "orm" in tex_set:
        img_node = nodes.new("ShaderNodeTexImage")
        img_node.image = load_image(tex_set["orm"])
        img_node.image.colorspace_settings.name = "Non-Color"
        sep = nodes.new("ShaderNodeSeparateColor")
        links.new(img_node.outputs["Color"], sep.inputs["Color"])
        links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
        used["orm"] = os.path.basename(tex_set["orm"])
    elif "roughness" in tex_set:
        img_node = nodes.new("ShaderNodeTexImage")
        img_node.image = load_image(tex_set["roughness"])
        img_node.image.colorspace_settings.name = "Non-Color"
        links.new(img_node.outputs["Color"], bsdf.inputs["Roughness"])
        used["roughness"] = os.path.basename(tex_set["roughness"])

    if "emissive" in tex_set:
        img_node = nodes.new("ShaderNodeTexImage")
        img_node.image = load_image(tex_set["emissive"])
        links.new(img_node.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = 2.0
        used["emissive"] = os.path.basename(tex_set["emissive"])

    if "opacity" in tex_set:
        img_node = nodes.new("ShaderNodeTexImage")
        img_node.image = load_image(tex_set["opacity"])
        img_node.image.colorspace_settings.name = "Non-Color"
        links.new(img_node.outputs["Color"], bsdf.inputs["Alpha"])
        mat.blend_method = "BLEND"
        used["opacity"] = os.path.basename(tex_set["opacity"])

    return used


materials = []
texture_files = set()
for mat in bpy.data.materials:
    # 1. Repoint the FBX's own texture references into the kit's Textures dir.
    rescued, key_hints = rescue_fbx_references(mat)
    # 2. Drop whatever still points at missing files.
    strip_broken_image_nodes(mat)
    # 3. Fill remaining roles by naming convention (hinted by the FBX refs).
    wired = wire_material(mat, key_hints=key_hints, skip_roles=set(rescued))
    combined = {**rescued, **(wired or {})}
    entry = {"name": mat.name, "textures": combined}
    for role, val in combined.items():
        if role != "key":
            texture_files.add(val)
    materials.append(entry)

# ---------------------------------------------------------------------------
# Metadata
# ---------------------------------------------------------------------------

depsgraph = bpy.context.evaluated_depsgraph_get()
triangles = 0
vertices = 0
for obj in mesh_objects:
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    mesh.calc_loop_triangles()
    triangles += len(mesh.loop_triangles)
    vertices += len(mesh.vertices)
    eval_obj.to_mesh_clear()

bbox_min = Vector((math.inf,) * 3)
bbox_max = Vector((-math.inf,) * 3)
for obj in mesh_objects:
    for corner in obj.bound_box:
        world = obj.matrix_world @ Vector(corner)
        bbox_min = Vector(map(min, bbox_min, world))
        bbox_max = Vector(map(max, bbox_max, world))
dims = bbox_max - bbox_min

def material_is_transparent(mat):
    if not mat.use_nodes:
        return False
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        return False
    alpha = bsdf.inputs.get("Alpha")
    if alpha is None:
        return False
    return alpha.is_linked or alpha.default_value < 0.999


has_transparency = any(material_is_transparent(m) for m in bpy.data.materials) or any(
    "opacity" in e["textures"] for e in materials
)
has_emissive = any("emissive" in e["textures"] for e in materials)
has_animation = len(bpy.data.actions) > 0

texture_info = []
for img in bpy.data.images:
    if img.source == "FILE" and img.filepath and os.path.exists(bpy.path.abspath(img.filepath)):
        texture_info.append(
            {
                "file": os.path.basename(img.filepath),
                "width": img.size[0],
                "height": img.size[1],
            }
        )

meta = {
    "name": args.name,
    "source_fbx": os.path.basename(args.fbx),
    "dimensions_m": [round(dims.x, 3), round(dims.y, 3), round(dims.z, 3)],
    "bbox_min": [round(v, 3) for v in bbox_min],
    "bbox_max": [round(v, 3) for v in bbox_max],
    "triangles": triangles,
    "vertices": vertices,
    "objects": len(mesh_objects),
    "collision_objects": collision_count,
    "materials": materials,
    "material_count": len(bpy.data.materials),
    "textures": texture_info,
    "has_transparency": bool(has_transparency),
    "has_emissive": bool(has_emissive),
    "has_animation": bool(has_animation),
}

# ---------------------------------------------------------------------------
# Thumbnails: 4 turntable angles
# ---------------------------------------------------------------------------

center = (bbox_min + bbox_max) / 2
radius = max(dims.length / 2, 0.01)

cam_data = bpy.data.cameras.new("LabCam")
cam_obj = bpy.data.objects.new("LabCam", cam_data)
bpy.context.scene.collection.objects.link(cam_obj)
bpy.context.scene.camera = cam_obj
cam_data.clip_end = max(1000.0, radius * 20)

sun_data = bpy.data.lights.new("LabSun", type="SUN")
sun_data.energy = 5.0
sun_obj = bpy.data.objects.new("LabSun", sun_data)
sun_obj.rotation_euler = (math.radians(50), 0, math.radians(30))
bpy.context.scene.collection.objects.link(sun_obj)

fill_data = bpy.data.lights.new("LabFill", type="SUN")
fill_data.energy = 2.0
fill_obj = bpy.data.objects.new("LabFill", fill_data)
fill_obj.rotation_euler = (math.radians(-40), 0, math.radians(210))
bpy.context.scene.collection.objects.link(fill_obj)

world = bpy.data.worlds.new("LabWorld")
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
if bg:
    bg.inputs[0].default_value = (0.08, 0.09, 0.12, 1.0)
    bg.inputs[1].default_value = 1.6
bpy.context.scene.world = world

scene = bpy.context.scene
scene.render.resolution_x = args.thumb_size
scene.render.resolution_y = args.thumb_size
scene.render.film_transparent = False
scene.render.image_settings.file_format = "PNG"

# EEVEE for textured previews (engine id varies across Blender versions).
for engine_id in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "BLENDER_WORKBENCH"):
    try:
        scene.render.engine = engine_id
        break
    except Exception:
        continue


def look_at(obj, target):
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


dist = radius * 3.0
elev = math.radians(22)
for i, azimuth_deg in enumerate((35, 125, 215, 305)):
    az = math.radians(azimuth_deg)
    cam_obj.location = center + Vector(
        (
            dist * math.cos(elev) * math.cos(az),
            dist * math.cos(elev) * math.sin(az),
            dist * math.sin(elev),
        )
    )
    look_at(cam_obj, center)
    scene.render.filepath = os.path.join(thumbs_dir, f"{i:02d}.png")
    try:
        bpy.ops.render.render(write_still=True)
    except Exception as exc:  # keep going; thumbs are non-critical
        print(f"ASSETLAB_WARN: render failed ({exc}); retrying with Workbench")
        try:
            scene.render.engine = "BLENDER_WORKBENCH"
            bpy.ops.render.render(write_still=True)
        except Exception as exc2:
            print(f"ASSETLAB_WARN: workbench render failed too ({exc2})")

# ---------------------------------------------------------------------------
# Preview GLB export (delete lab helpers first)
# ---------------------------------------------------------------------------

for obj in (cam_obj, sun_obj, fill_obj):
    bpy.data.objects.remove(obj, do_unlink=True)

glb_path = os.path.join(args.out_dir, "preview.glb")
bpy.ops.export_scene.gltf(
    filepath=glb_path,
    export_format="GLB",
    export_yup=True,
    export_apply=True,
    export_image_format="AUTO",
)
meta["preview_glb_bytes"] = os.path.getsize(glb_path) if os.path.exists(glb_path) else 0

with open(os.path.join(args.out_dir, "meta.json"), "w", encoding="utf8") as f:
    json.dump(meta, f, indent=2)

print("ASSETLAB_OK " + json.dumps({"triangles": triangles, "materials": len(materials)}))
