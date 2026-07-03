"""One-off probe: area-weighted face-normal distribution of an FBX, bucketed
by region, to determine which way an L-corner module's facades face.

Usage:
  blender -b --factory-startup -P probe_corner_normals.py -- --fbx <file.fbx>
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

# Region buckets over the plan (x, y), each accumulating area per normal axis.
REGIONS = {
    "x<2": lambda c: c.x < 2,
    "x 2..10": lambda c: 2 <= c.x <= 10,
    "x>10": lambda c: c.x > 10,
}
BANDS = {
    "y<2": lambda c: c.y < 2,
    "y 2..10": lambda c: 2 <= c.y <= 10,
    "y>10": lambda c: c.y > 10,
}


def axis_of(n):
    ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
    if az > ax and az > ay:
        return "+z" if n.z > 0 else "-z"
    if ax > ay:
        return "+x" if n.x > 0 else "-x"
    return "+y" if n.y > 0 else "-y"


stats = {}
for obj in bpy.data.objects:
    if obj.type != "MESH" or obj.name.lower().startswith(("ucx_", "ubx_", "usp_", "ucp_")):
        continue
    if "lod" in obj.name.lower() and not obj.name.lower().endswith("lod0"):
        continue
    mw = obj.matrix_world
    nm = mw.inverted().transposed().to_3x3()
    for poly in obj.data.polygons:
        c = mw @ poly.center
        n = (nm @ poly.normal).normalized()
        for rn, rp in REGIONS.items():
            if not rp(c):
                continue
            for bn, bp in BANDS.items():
                if not bp(c):
                    continue
                key = (rn, bn, axis_of(n))
                stats[key] = stats.get(key, 0.0) + poly.area

for (rn, bn, ax), area in sorted(stats.items(), key=lambda kv: -kv[1]):
    if area < 20000:  # cm^2 scale in raw FBX; skip noise
        continue
    print(f"REGION {rn} | {bn} | normal {ax}: area {area:.0f}")
print("PROBE_OK")
