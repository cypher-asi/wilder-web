"""Headless Blender optimize worker: executes a constrained recipe.

Works from the imported preview.glb (materials already wired) and performs
only deterministic, recipe-approved operations:
  - merge vertices by distance (weld)
  - decimate (collapse) to a recipe ratio
  - recalculate outside normals
  - remove empties / non-mesh leftovers
  - normalize pivot (bottom-center at origin)
  - rename objects/materials to the asset id

Usage:
  blender -b --factory-startup -P optimize_asset.py -- \
      --in <preview.glb> --out <optimized.glb> --recipe <recipe.json> --name <asset_id>
"""

import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--in", dest="input", required=True)
parser.add_argument("--out", dest="output", required=True)
parser.add_argument("--recipe", required=True)
parser.add_argument("--name", required=True)
args = parser.parse_args(argv)

with open(args.recipe, "r", encoding="utf8") as f:
    recipe = json.load(f)

decimate_ratio = float(recipe.get("decimate_ratio", 1.0))
weld_distance = float(recipe.get("weld_distance", 0.0005))
normalize_pivot = recipe.get("normalize_pivot", "bottom_center")

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=args.input)

# Drop non-mesh leftovers (empties, cameras, lights).
for obj in list(bpy.data.objects):
    if obj.type != "MESH":
        bpy.data.objects.remove(obj, do_unlink=True)

mesh_objects = [o for o in bpy.data.objects if o.type == "MESH"]
if not mesh_objects:
    print("ASSETLAB_ERROR: no mesh objects in input GLB")
    sys.exit(2)

bpy.ops.object.select_all(action="DESELECT")
for obj in mesh_objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = mesh_objects[0]
try:
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
except RuntimeError:
    pass

for obj in mesh_objects:
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    if weld_distance > 0:
        bpy.ops.mesh.remove_doubles(threshold=weld_distance)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")

    if 0 < decimate_ratio < 1.0:
        mod = obj.modifiers.new("LabDecimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = decimate_ratio
        # Keep UV seams intact so textures survive decimation.
        mod.delimit = {"UV"}
        bpy.ops.object.modifier_apply(modifier=mod.name)

# Normalize pivot: bottom-center of the combined bounds sits at the origin.
if normalize_pivot == "bottom_center":
    bbox_min = Vector((math.inf,) * 3)
    bbox_max = Vector((-math.inf,) * 3)
    for obj in mesh_objects:
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            bbox_min = Vector(map(min, bbox_min, world))
            bbox_max = Vector(map(max, bbox_max, world))
    center = (bbox_min + bbox_max) / 2
    offset = Vector((center.x, center.y, bbox_min.z))
    for obj in mesh_objects:
        obj.location -= offset
    bpy.ops.object.select_all(action="DESELECT")
    for obj in mesh_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objects[0]
    try:
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    except RuntimeError:
        pass

# Standardize names.
for i, obj in enumerate(sorted(mesh_objects, key=lambda o: o.name)):
    obj.name = args.name if len(mesh_objects) == 1 else f"{args.name}_{i:02d}"
    if obj.data:
        obj.data.name = obj.name
for i, mat in enumerate(bpy.data.materials):
    mat.name = f"{args.name}_mat{i:02d}" if len(bpy.data.materials) > 1 else f"{args.name}_mat"

depsgraph = bpy.context.evaluated_depsgraph_get()
triangles = 0
for obj in mesh_objects:
    mesh = obj.evaluated_get(depsgraph).to_mesh()
    mesh.calc_loop_triangles()
    triangles += len(mesh.loop_triangles)
    obj.evaluated_get(depsgraph).to_mesh_clear()

os.makedirs(os.path.dirname(args.output), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=args.output,
    export_format="GLB",
    export_yup=True,
    export_apply=True,
    export_image_format="AUTO",
)

print("ASSETLAB_OK " + json.dumps({"triangles": triangles}))
