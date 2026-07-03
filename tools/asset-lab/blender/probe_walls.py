"""One-off probe: which bbox side planes of an FBX hold wall geometry.

Counts vertices within a threshold slab of each vertical bbox side, per z
band, to identify the wall legs of straight/corner facade modules in the
kit's authored frame (+x right, +y back/interior, z up).

Usage:
  blender -b --factory-startup -P probe_walls.py -- --fbx <file.fbx>
"""

import argparse
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--fbx", required=True)
parser.add_argument("--slab", type=float, default=0.6)
args = parser.parse_args(argv)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=args.fbx)

verts = []
lo = Vector((float("inf"),) * 3)
hi = Vector((float("-inf"),) * 3)
for obj in bpy.data.objects:
    if obj.type != "MESH" or obj.name.lower().startswith(("ucx_", "ubx_", "usp_", "ucp_")):
        continue
    for v in obj.data.vertices:
        w = obj.matrix_world @ v.co
        verts.append(w)
        lo = Vector(map(min, lo, w))
        hi = Vector(map(max, hi, w))

print(f"BBOX x[{lo.x:.2f},{hi.x:.2f}] y[{lo.y:.2f},{hi.y:.2f}] z[{lo.z:.2f},{hi.z:.2f}]")
t = args.slab
total = len(verts)
sides = {
    "x_min": lambda w: w.x - lo.x < t,
    "x_max": lambda w: hi.x - w.x < t,
    "y_min(front)": lambda w: w.y - lo.y < t,
    "y_max(back)": lambda w: hi.y - w.y < t,
    "y_zero(pivot)": lambda w: abs(w.y) < t,
    "x_zero(pivot)": lambda w: abs(w.x) < t,
}
for name, pred in sides.items():
    n = sum(1 for w in verts if pred(w))
    print(f"SIDE {name}: {n} ({100 * n / total:.0f}%)")
print("PROBE_OK")
