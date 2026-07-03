"""One-off probe: wall-plane offsets of an L-corner facade module.

Histograms vertex counts along y in the leg_a strip (mid x, excluding the
perpendicular leg) and along x in the leg_b strip, to locate each leg's
authored wall plane relative to the bbox in the kit frame.

Usage:
  blender -b --factory-startup -P probe_corner_walls.py -- --fbx <file.fbx>
"""

import argparse
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--fbx", required=True)
args = parser.parse_args(argv)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=args.fbx)

verts = []
for obj in bpy.data.objects:
    if obj.type != "MESH" or obj.name.lower().startswith(("ucx_", "ubx_", "usp_", "ucp_")):
        continue
    if "lod" in obj.name.lower() and not obj.name.lower().endswith("lod0"):
        continue
    verts.extend(obj.matrix_world @ v.co for v in obj.data.vertices)

xs = [v.x for v in verts]
ys = [v.y for v in verts]
print(f"BBOX x[{min(xs):.3f},{max(xs):.3f}] y[{min(ys):.3f},{max(ys):.3f}]")

# leg_a: strip away from leg_b (x in [4,10]); histogram y in 0.25m bins.
BIN = 0.25
hist_a = {}
for v in verts:
    if 4 <= v.x <= 10:
        hist_a[round(v.y / BIN)] = hist_a.get(round(v.y / BIN), 0) + 1
print("LEG_A y-histogram (x in 4..10):")
for k in sorted(hist_a):
    print(f"  y={k * BIN:6.2f}: {hist_a[k]}")

# leg_b: strip y in 2..8; histogram x.
hist_b = {}
for v in verts:
    if 2 <= v.y <= 8:
        hist_b[round(v.x / BIN)] = hist_b.get(round(v.x / BIN), 0) + 1
print("LEG_B x-histogram (y in 2..8):")
for k in sorted(hist_b):
    print(f"  x={k * BIN:6.2f}: {hist_b[k]}")
print("PROBE_OK")
