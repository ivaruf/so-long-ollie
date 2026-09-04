"""
Build a cute low-poly gopher in Blender and export it as GLB.

Run headless:
    blender -b --python blender/gopher.py -- --out assets/gopher.glb --render assets/gopher-preview

Coordinate conventions (Blender): Z up, the gopher faces -Y, feet on Z=0.
The glTF exporter converts to Y-up, so in Babylon the gopher faces +Z.

Object hierarchy (names are the contract the web game relies on):
    Gopher (empty)
      Body
        Belly, Tail
        Head  -> Muzzle, Nose, ToothL/R, EyeL/R (-> pupils, highlights), EarL/R, CheekL/R
        ArmL/ArmR -> HandL/HandR
        LegL/LegR -> FootL/FootR
Pivots: Head at the neck, Arm at the shoulder, Leg at the hip, Tail at its base.
"""
import math
import sys

import bpy
from mathutils import Vector

# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT_GLB = None
RENDER_PREFIX = None
i = 0
while i < len(argv):
    if argv[i] == "--out":
        OUT_GLB = argv[i + 1]; i += 2
    elif argv[i] == "--render":
        RENDER_PREFIX = argv[i + 1]; i += 2
    else:
        i += 1

# Global scale so the finished gopher is ~1.0 unit tall (design units are a bit larger).
S = 0.89

# ----------------------------------------------------------------------------
# Scene reset
# ----------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ----------------------------------------------------------------------------
# Materials (flat, toy-like colours; glTF picks up Base Color / Roughness)
# ----------------------------------------------------------------------------
def material(name, rgb, roughness=0.65):
    mat = bpy.data.materials.new(name)
    if mat.node_tree is None:  # older Blender versions start without a node tree
        mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        out = nodes.get("Material Output") or nodes.new("ShaderNodeOutputMaterial")
        mat.node_tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0.0
    return mat

MAT = {
    "fur":     material("Fur",      (0.46, 0.26, 0.12)),
    "belly":   material("Belly",    (0.86, 0.70, 0.50)),
    "dark":    material("DarkFur",  (0.30, 0.16, 0.07)),
    "whisker": material("Whisker",  (0.12, 0.08, 0.06)),
    "nose":    material("Nose",     (0.90, 0.40, 0.48), 0.4),
    "innerear":material("InnerEar", (0.93, 0.62, 0.62)),
    "teeth":   material("Teeth",    (0.98, 0.97, 0.92), 0.3),
    "white":   material("EyeWhite", (1.00, 1.00, 1.00), 0.25),
    "black":   material("Pupil",    (0.03, 0.03, 0.03), 0.2),
    "cheek":   material("Cheek",    (0.93, 0.50, 0.45)),
}

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
PIVOT = {}  # object -> world-space pivot position (all parents are pure translations)

def V(x, y, z):
    return Vector((x * S, y * S, z * S))

def _finish(obj, name, mat, parent, pivot_world, center_world, radii_or_size):
    """Shift mesh so its origin is at pivot_world, parent it, and smooth-shade it."""
    obj.name = name
    obj.data.name = name
    mesh = obj.data
    offset = center_world - pivot_world
    for v in mesh.vertices:
        v.co = Vector((v.co.x * radii_or_size.x, v.co.y * radii_or_size.y, v.co.z * radii_or_size.z)) + offset
    for p in mesh.polygons:
        p.use_smooth = True
    mesh.materials.append(mat)
    if parent is not None:
        obj.parent = parent
        obj.location = pivot_world - PIVOT[parent]
    else:
        obj.location = pivot_world
    PIVOT[obj] = pivot_world
    return obj

def sphere(name, center, radii, mat, parent, pivot=None, detail=1.0):
    """Ellipsoid. center/radii given as world-space Vectors (already scaled)."""
    if pivot is None:
        pivot = center
    segs = max(8, int(24 * detail))
    rings = max(4, int(12 * detail))
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=rings, radius=1.0, location=(0, 0, 0))
    return _finish(bpy.context.active_object, name, mat, parent, pivot, center, radii)

def box(name, center, size, mat, parent, pivot=None):
    if pivot is None:
        pivot = center
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0))
    obj = bpy.context.active_object
    for p in obj.data.polygons:
        p.use_smooth = False
    return _finish(obj, name, mat, parent, pivot, center, size)

def empty(name, location, parent=None):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    obj.empty_display_size = 0.2
    if parent is not None:
        obj.parent = parent
        obj.location = location - PIVOT[parent]
    else:
        obj.location = location
    PIVOT[obj] = location
    return obj

# ----------------------------------------------------------------------------
# Build the gopher
# ----------------------------------------------------------------------------
root = empty("Gopher", V(0, 0, 0))

# Body: chubby egg
body = sphere("Body", V(0, 0, 0.40), V(0.30, 0.27, 0.32), MAT["fur"], root)
sphere("Belly", V(0, -0.10, 0.36), V(0.20, 0.20, 0.24), MAT["belly"], body)

# Tail: little tuft at the back, pivot at its base
sphere("Tail", V(0, 0.30, 0.35), V(0.07, 0.07, 0.07), MAT["dark"], body, pivot=V(0, 0.25, 0.35), detail=0.7)

# Head: big round head, pivot at the neck
head = sphere("Head", V(0, -0.05, 0.80), V(0.32, 0.32, 0.32), MAT["fur"], body, pivot=V(0, -0.03, 0.56))
sphere("Muzzle", V(0, -0.30, 0.72), V(0.17, 0.12, 0.13), MAT["belly"], head)
sphere("Nose", V(0, -0.43, 0.77), V(0.045, 0.045, 0.04), MAT["nose"], head, detail=0.7)

# Buck teeth (the gopher signature)
for sx, nm in ((-1, "ToothL"), (1, "ToothR")):
    box(nm, V(sx * 0.028, -0.395, 0.615), V(0.048, 0.035, 0.085), MAT["teeth"], head)

# Eyes with pupils and a highlight; the eye node is what blinks
head_c = V(0, -0.05, 0.80)
for sx, nm in ((-1, "EyeL"), (1, "EyeR")):
    ec = V(sx * 0.13, -0.28, 0.86)
    eye = sphere(nm, ec, V(0.085, 0.085, 0.085), MAT["white"], head)
    n = (ec - head_c).normalized()
    pupil = sphere(nm + "Pupil", ec + n * (0.048 * S), V(0.056, 0.056, 0.056), MAT["black"], eye, detail=0.7)
    hl = ec + n * (0.092 * S) + V(sx * 0.012, 0, 0.025)
    sphere(nm + "Shine", hl, V(0.016, 0.016, 0.016), MAT["white"], eye, detail=0.5)

# Ears
for sx, nm in ((-1, "EarL"), (1, "EarR")):
    ec = V(sx * 0.24, 0.02, 1.05)
    ear = sphere(nm, ec, V(0.075, 0.075, 0.075), MAT["fur"], head, detail=0.8)
    sphere(nm + "Inner", ec + V(0, -0.03, 0), V(0.045, 0.045, 0.045), MAT["innerear"], ear, detail=0.6)

# Whiskers: three thin rods per side, fanned out from the muzzle
def rod(name, center, radius, length, mat, parent):
    bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=1.0, depth=1.0, location=(0, 0, 0))
    return _finish(bpy.context.active_object, name, mat, parent, center, center, V(radius, radius, length))

for sx, side in ((-1, "L"), (1, "R")):
    for k in (-1, 0, 1):
        w = rod(f"Whisker{side}{k+2}", V(sx * 0.235, -0.33, 0.715 + 0.012 * k), 0.0045, 0.14, MAT["whisker"], head)
        w.rotation_euler = (0.0, math.radians(90 + 14 * k * sx), math.radians(-12 * sx))

# Rosy cheeks
for sx, nm in ((-1, "CheekL"), (1, "CheekR")):
    sphere(nm, V(sx * 0.215, -0.265, 0.71), V(0.05, 0.04, 0.035), MAT["cheek"], head, detail=0.7)

# Arms: pivot at the shoulder, hang forward-down
for sx, nm in ((-1, "ArmL"), (1, "ArmR")):
    sh = V(sx * 0.24, -0.10, 0.56)
    arm = sphere(nm, sh + V(0, -0.02, -0.10), V(0.07, 0.07, 0.12), MAT["fur"], body, pivot=sh, detail=0.8)
    sphere("Hand" + nm[-1], sh + V(0, -0.04, -0.21), V(0.065, 0.07, 0.055), MAT["dark"], arm, detail=0.7)
    arm.rotation_euler.x = -0.75  # forward

# Legs: pivot at the hip, feet on the floor
for sx, nm in ((-1, "LegL"), (1, "LegR")):
    hip = V(sx * 0.13, 0.0, 0.19)
    leg = sphere(nm, hip + V(0, -0.01, -0.09), V(0.095, 0.10, 0.10), MAT["fur"], body, pivot=hip, detail=0.8)
    sphere("Foot" + nm[-1], hip + V(0, -0.09, -0.145), V(0.095, 0.15, 0.045), MAT["dark"], leg, detail=0.8)

# ----------------------------------------------------------------------------
# Sanity: report bounds
# ----------------------------------------------------------------------------
bpy.context.view_layer.update()
lo = Vector((1e9, 1e9, 1e9)); hi = Vector((-1e9, -1e9, -1e9))
for obj in PIVOT:
    if obj.type != "MESH":
        continue
    for v in obj.data.vertices:
        w = obj.matrix_world @ v.co
        lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
print(f"GOPHER_BOUNDS min={tuple(round(c,3) for c in lo)} max={tuple(round(c,3) for c in hi)} height={hi.z-lo.z:.3f}")

# ----------------------------------------------------------------------------
# Export GLB (model only)
# ----------------------------------------------------------------------------
if OUT_GLB:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in PIVOT:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_texcoords=False,
        export_materials="EXPORT",
    )
    print("GOPHER_EXPORTED", OUT_GLB)

# ----------------------------------------------------------------------------
# Preview renders (Eevee): three angles
# ----------------------------------------------------------------------------
if RENDER_PREFIX:
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 24
    scene.render.resolution_x = 700
    scene.render.resolution_y = 700
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"

    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.82, 0.86, 0.90, 1.0)
    bg.inputs["Strength"].default_value = 1.0

    # Floor so the shadow reads
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.data.materials.append(material("Floor", (0.80, 0.80, 0.78), 0.9))

    sun_data = bpy.data.lights.new("Sun", type="SUN")
    sun_data.energy = 3.5
    sun_data.angle = math.radians(6)
    sun = bpy.data.objects.new("Sun", sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(50), math.radians(-15), math.radians(-35))

    fill_data = bpy.data.lights.new("Fill", type="AREA")
    fill_data.energy = 150
    fill_data.size = 4
    fill = bpy.data.objects.new("Fill", fill_data)
    scene.collection.objects.link(fill)
    fill.location = (-2.5, -2.0, 2.0)
    fill.rotation_euler = (Vector((0, 0, 0.5)) - fill.location).to_track_quat("-Z", "Y").to_euler()

    cam_data = bpy.data.cameras.new("Camera")
    cam_data.lens = 55
    cam = bpy.data.objects.new("Camera", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    target = Vector((0, 0, 0.50))
    views = {
        "front34": Vector((1.7, -2.3, 1.15)),
        "front":   Vector((0.0, -2.9, 0.85)),
        "side":    Vector((2.9, 0.0, 0.85)),
        "back34":  Vector((-1.7, 2.3, 1.15)),
    }
    for name, pos in views.items():
        cam.location = pos
        cam.rotation_euler = (target - pos).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = f"{RENDER_PREFIX}-{name}.png"
        bpy.ops.render.render(write_still=True)
        print("GOPHER_RENDERED", scene.render.filepath)
