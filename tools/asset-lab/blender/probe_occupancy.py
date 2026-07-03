"""One-off probe: ASCII top-view (x/y) vertex-density map of an FBX, to see
the plan shape of a module (straight wall vs L-corner vs full ring) in the
kit's authored coordinate frame.

Usage:
  blender -b --factory-startup -P probe_occupancy.py -- --fbx <file.fbx> [--cells 12]
"""

import argparse
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--fbx", required=True)
parser.add_argument("--cells", type=int, default=12)
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

n = args.cells
sx = (hi.x - lo.x) or 1
sy = (hi.y - lo.y) or 1
grid = [[0] * n for _ in range(n)]
for w in verts:
    ix = min(n - 1, int((w.x - lo.x) / sx * n))
    iy = min(n - 1, int((w.y - lo.y) / sy * n))
    grid[iy][ix] += 1

peak = max(max(row) for row in grid) or 1
print(f"TOPVIEW rows=+y..-y cols=-x..+x peak={peak}")
for iy in range(n - 1, -1, -1):
    line = ""
    for ix in range(n):
        d = grid[iy][ix] / peak
        line += "#" if d > 0.25 else "+" if d > 0.08 else "." if d > 0 else " "
    print(f"|{line}|  y={lo.y + (iy + 0.5) / n * sy:.1f}")
print("PROBE_OK")
