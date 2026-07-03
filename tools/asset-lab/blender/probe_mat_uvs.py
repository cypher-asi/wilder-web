"""One-off probe: per-material UV bounds and face area in an FBX, to check
whether faces assigned to untextured materials carry authored UVs.

Usage:
  blender -b --factory-startup -P probe_mat_uvs.py -- --fbx <file.fbx>
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

stats = {}
for obj in bpy.data.objects:
    if obj.type != "MESH" or obj.name.lower().startswith(("ucx_", "ubx_", "usp_", "ucp_")):
        continue
    if "lod" in obj.name.lower() and not obj.name.lower().endswith("lod0"):
        continue
    mesh = obj.data
    uv = mesh.uv_layers.active
    for poly in mesh.polygons:
        mat = obj.material_slots[poly.material_index].material if obj.material_slots else None
        name = mat.name if mat else "(none)"
        s = stats.setdefault(name, {"faces": 0, "area": 0.0, "umin": 1e9, "umax": -1e9, "vmin": 1e9, "vmax": -1e9})
        s["faces"] += 1
        s["area"] += poly.area
        if uv:
            for li in poly.loop_indices:
                u, v = uv.data[li].uv
                s["umin"] = min(s["umin"], u)
                s["umax"] = max(s["umax"], u)
                s["vmin"] = min(s["vmin"], v)
                s["vmax"] = max(s["vmax"], v)

for name, s in stats.items():
    print(
        f"MAT {name}: faces={s['faces']} area={s['area']:.1f}m2 "
        f"u[{s['umin']:.2f},{s['umax']:.2f}] v[{s['vmin']:.2f},{s['vmax']:.2f}]"
    )
print("PROBE_OK")
