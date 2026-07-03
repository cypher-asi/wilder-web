"""One-off probe: dump the object hierarchy of an FBX assembly.

For each object: name, mesh data name (usually references the source module),
world location, rotation (deg), scale, and world bbox. This recovers the kit
author's own placement recipe from pre-assembled prefab/group meshes.

Usage:
  blender -b --factory-startup -P probe_assembly.py -- --fbx <file.fbx>
"""

import argparse
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--fbx", required=True)
args = parser.parse_args(argv)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=args.fbx)

print(f"OBJECTS {len(bpy.data.objects)}")
for obj in bpy.data.objects:
    loc = obj.matrix_world.translation
    rot = [round(a, 1) for a in [__import__('math').degrees(v) for v in obj.matrix_world.to_euler()]]
    scl = [round(v, 3) for v in obj.matrix_world.to_scale()]
    data = obj.data.name if obj.data is not None else "-"
    print(
        f"OBJ type={obj.type} name={obj.name!r} data={data!r} "
        f"parent={obj.parent.name if obj.parent else '-'} "
        f"loc=({loc.x:.2f},{loc.y:.2f},{loc.z:.2f}) rot={rot} scale={scl}"
    )
    if obj.type == "MESH":
        bb_min = Vector((float("inf"),) * 3)
        bb_max = Vector((float("-inf"),) * 3)
        for corner in obj.bound_box:
            w = obj.matrix_world @ Vector(corner)
            bb_min = Vector(map(min, bb_min, w))
            bb_max = Vector(map(max, bb_max, w))
        print(
            f"  bbox x[{bb_min.x:.2f},{bb_max.x:.2f}] "
            f"y[{bb_min.y:.2f},{bb_max.y:.2f}] z[{bb_min.z:.2f},{bb_max.z:.2f}] "
            f"mats={[m.name for m in obj.data.materials]}"
        )

print("PROBE_OK")
