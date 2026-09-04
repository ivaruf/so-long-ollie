"""
Build the striped scarf gopher from the supplied character reference.

The script emits either the grounded character or the same character riding an
opaque, fluffy cloud.  Both variants retain the node names used by game.js so
the existing procedural idle/run animation can be reused later.

Headless examples:
    blender -b --python blender/gopher_scarf.py -- \
      --variant plain --out assets/gopher-scarf.glb
    blender -b --python blender/gopher_scarf.py -- \
      --variant cloud --out assets/gopher-scarf-cloud.glb

Blender coordinates: Z up, character faces -Y.  glTF exports Y up and faces +Z.
"""

import math
import os
import sys

import bpy
from mathutils import Vector


# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT_GLB = None
OUT_BLEND = None
RENDER_PREFIX = None
VARIANT = "plain"

i = 0
while i < len(argv):
    if argv[i] == "--variant":
        VARIANT = argv[i + 1]
        i += 2
    elif argv[i] == "--out":
        OUT_GLB = argv[i + 1]
        i += 2
    elif argv[i] == "--blend":
        OUT_BLEND = argv[i + 1]
        i += 2
    elif argv[i] == "--render":
        RENDER_PREFIX = argv[i + 1]
        i += 2
    else:
        i += 1

if VARIANT not in {"plain", "cloud"}:
    raise ValueError("--variant must be either 'plain' or 'cloud'")

S = 0.89
RIDER_LIFT = 0.31 if VARIANT == "cloud" else 0.0


# -----------------------------------------------------------------------------
# Scene and materials
# -----------------------------------------------------------------------------

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def material(name, rgb, roughness=0.72, metallic=0.0):
    """Opaque Principled material suitable for Blender and glTF."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*rgb, 1.0)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if "Alpha" in bsdf.inputs:
        bsdf.inputs["Alpha"].default_value = 1.0
    return mat


MAT = {
    "cream": material("CreamFur", (0.93, 0.90, 0.82), 0.82),
    "warm": material("WarmFur", (0.82, 0.75, 0.63), 0.82),
    "black": material("ScarfBlack", (0.012, 0.014, 0.018), 0.58),
    "eye": material("EyeWhite", (1.0, 0.99, 0.96), 0.25),
    "pupil": material("Pupil", (0.008, 0.009, 0.012), 0.18),
    "tooth": material("Tooth", (1.0, 0.99, 0.94), 0.30),
    "inner_ear": material("InnerEar", (0.77, 0.58, 0.54), 0.78),
    # Fully opaque: no alpha blend, transmission, or glass nodes are used.
    "cloud": material("OpaqueCloud", (1.0, 1.0, 1.0), 0.94),
}


# -----------------------------------------------------------------------------
# Geometry helpers
# -----------------------------------------------------------------------------

PIVOT = {}


def V(x, y, z):
    return Vector((x * S, y * S, z * S))


def _finish(obj, name, mat, parent, pivot_world, center_world, scale, smooth=True):
    obj.name = name
    obj.data.name = name
    offset = center_world - pivot_world
    for vertex in obj.data.vertices:
        vertex.co = Vector(
            (vertex.co.x * scale.x, vertex.co.y * scale.y, vertex.co.z * scale.z)
        ) + offset
    for polygon in obj.data.polygons:
        polygon.use_smooth = smooth
    obj.data.materials.append(mat)
    if parent is None:
        obj.location = pivot_world
    else:
        obj.parent = parent
        obj.location = pivot_world - PIVOT[parent]
    PIVOT[obj] = pivot_world
    return obj


def empty(name, location, parent=None):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    obj.empty_display_size = 0.12
    if parent is None:
        obj.location = location
    else:
        obj.parent = parent
        obj.location = location - PIVOT[parent]
    PIVOT[obj] = location
    return obj


def sphere(name, center, radii, mat, parent, pivot=None, detail=1.0):
    pivot = center if pivot is None else pivot
    segments = max(10, int(28 * detail))
    rings = max(6, int(16 * detail))
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=segments, ring_count=rings, radius=1.0, location=(0, 0, 0)
    )
    return _finish(
        bpy.context.active_object, name, mat, parent, pivot, center, radii, True
    )


def box(name, center, size, mat, parent, pivot=None, bevel=0.0):
    pivot = center if pivot is None else pivot
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0))
    obj = _finish(
        bpy.context.active_object, name, mat, parent, pivot, center, size, False
    )
    if bevel > 0:
        modifier = obj.modifiers.new("SoftEdges", "BEVEL")
        modifier.width = bevel * S
        modifier.segments = 2
    return obj


def rod(name, center, radius, length, mat, parent, vertices=8):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices, radius=1.0, depth=1.0, location=(0, 0, 0)
    )
    return _finish(
        bpy.context.active_object,
        name,
        mat,
        parent,
        center,
        center,
        V(radius, radius, length),
        True,
    )


def mesh_object(name, vertices, faces, mat, parent, pivot_world, smooth=True):
    """Create a mesh whose supplied vertices are in world coordinates."""
    mesh = bpy.data.meshes.new(name)
    local = [tuple(Vector(v) - pivot_world) for v in vertices]
    mesh.from_pydata(local, [], faces)
    mesh.update()
    mesh.materials.append(mat)
    for polygon in mesh.polygons:
        polygon.use_smooth = smooth
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    obj.parent = parent
    obj.location = pivot_world - PIVOT[parent]
    PIVOT[obj] = pivot_world
    return obj


def ellipsoid_band(name, center, radii, lat_bottom, lat_top, mat, parent, pivot):
    """A thin latitude band just above an ellipsoid surface."""
    segments = 48
    rows = 5
    vertices = []
    faces = []
    expanded = Vector((radii.x * 1.012, radii.y * 1.012, radii.z * 1.012))
    for row in range(rows + 1):
        latitude = math.radians(
            lat_bottom + (lat_top - lat_bottom) * row / rows
        )
        ring = math.cos(latitude)
        for col in range(segments):
            theta = 2 * math.pi * col / segments
            vertices.append(
                center
                + Vector(
                    (
                        expanded.x * ring * math.cos(theta),
                        expanded.y * ring * math.sin(theta),
                        expanded.z * math.sin(latitude),
                    )
                )
            )
    for row in range(rows):
        for col in range(segments):
            nxt = (col + 1) % segments
            a = row * segments + col
            b = row * segments + nxt
            c = (row + 1) * segments + nxt
            d = (row + 1) * segments + col
            faces.append((a, b, c, d))
    return mesh_object(name, vertices, faces, mat, parent, pivot, True)


def ribbon(name, points, widths, thickness, mat, parent, pivot):
    """Make a softly waving, opaque scarf ribbon in the X/Z plane."""
    vertices = []
    faces = []
    half_depth = thickness * S * 0.5
    for point, width in zip(points, widths):
        p = V(*point)
        half_width = width * S * 0.5
        # Front/back pairs for the upper and lower ribbon edge.
        vertices.extend(
            [
                p + Vector((0, -half_depth, half_width)),
                p + Vector((0, half_depth, half_width)),
                p + Vector((0, -half_depth, -half_width)),
                p + Vector((0, half_depth, -half_width)),
            ]
        )
    for idx in range(len(points) - 1):
        a = idx * 4
        b = (idx + 1) * 4
        faces.extend(
            [
                (a, b, b + 2, a + 2),
                (a + 1, a + 3, b + 3, b + 1),
                (a, a + 1, b + 1, b),
                (a + 2, b + 2, b + 3, a + 3),
            ]
        )
    end = len(vertices) - 4
    faces.extend([(0, 2, 3, 1), (end, end + 1, end + 3, end + 2)])
    return mesh_object(name, vertices, faces, mat, parent, pivot, False)


# -----------------------------------------------------------------------------
# Character
# -----------------------------------------------------------------------------

root = empty("Gopher", V(0, 0, 0))
character = empty("Character", V(0, 0, RIDER_LIFT), root)

body_center = V(0, 0, 0.42 + RIDER_LIFT)
body_radii = V(0.30, 0.255, 0.35)
body = sphere("Body", body_center, body_radii, MAT["cream"], character)

# Two black sweater-like stripes reproduce the bold horizontal marks in the
# drawing while leaving broad cream gaps between them.
ellipsoid_band(
    "StripeLower", body_center, body_radii, -38, -14, MAT["black"], body, body_center
)
ellipsoid_band(
    "StripeUpper", body_center, body_radii, 7, 29, MAT["black"], body, body_center
)

# Small tail at the back, visible from the side and three-quarter views.
sphere(
    "Tail",
    V(0, 0.265, 0.36 + RIDER_LIFT),
    V(0.075, 0.08, 0.07),
    MAT["warm"],
    body,
    pivot=V(0, 0.22, 0.36 + RIDER_LIFT),
    detail=0.75,
)

# Big simple head with the neck as its animation pivot.
head = sphere(
    "Head",
    V(0, -0.04, 0.82 + RIDER_LIFT),
    V(0.325, 0.30, 0.31),
    MAT["cream"],
    body,
    pivot=V(0, -0.02, 0.61 + RIDER_LIFT),
)

# Ears sit mostly behind the head silhouette.
for side, suffix in ((-1, "L"), (1, "R")):
    ear_center = V(side * 0.255, 0.015, 1.02 + RIDER_LIFT)
    ear = sphere(
        "Ear" + suffix,
        ear_center,
        V(0.073, 0.066, 0.073),
        MAT["cream"],
        head,
        detail=0.8,
    )
    sphere(
        "Ear" + suffix + "Inner",
        ear_center + V(0, -0.035, 0),
        V(0.042, 0.024, 0.043),
        MAT["inner_ear"],
        ear,
        detail=0.7,
    )

# Muzzle, nose, buck teeth.
sphere(
    "Muzzle",
    V(0, -0.294, 0.755 + RIDER_LIFT),
    V(0.145, 0.095, 0.115),
    MAT["warm"],
    head,
)
sphere(
    "Nose",
    V(0, -0.392, 0.80 + RIDER_LIFT),
    V(0.039, 0.031, 0.034),
    MAT["black"],
    head,
    detail=0.75,
)
for side, suffix in ((-1, "L"), (1, "R")):
    box(
        "Tooth" + suffix,
        V(side * 0.025, -0.365, 0.675 + RIDER_LIFT),
        V(0.043, 0.027, 0.072),
        MAT["tooth"],
        head,
        bevel=0.006,
    )

# Oversized graphic eyes, with pupils aimed slightly upward and toward the
# character's right as in the reference drawing.
head_center = V(0, -0.04, 0.82 + RIDER_LIFT)
for side, suffix in ((-1, "L"), (1, "R")):
    eye_center = V(side * 0.135, -0.278, 0.89 + RIDER_LIFT)
    eye = sphere(
        "Eye" + suffix,
        eye_center,
        V(0.092, 0.066, 0.106),
        MAT["eye"],
        head,
    )
    outward = (eye_center - head_center).normalized()
    pupil_center = eye_center + outward * (0.050 * S) + V(0.018, -0.006, 0.015)
    pupil = sphere(
        "Eye" + suffix + "Pupil",
        pupil_center,
        V(0.049, 0.031, 0.060),
        MAT["pupil"],
        eye,
        detail=0.8,
    )
    sphere(
        "Eye" + suffix + "Shine",
        pupil_center + outward * (0.029 * S) + V(-0.012, -0.006, 0.021),
        V(0.014, 0.010, 0.016),
        MAT["eye"],
        pupil,
        detail=0.55,
    )

# Light whiskers keep the result recognisably gopher-like without competing
# with the reference's strong black scarf silhouette.
for side, suffix in ((-1, "L"), (1, "R")):
    for row in (-1, 0, 1):
        whisker = rod(
            f"Whisker{suffix}{row + 2}",
            V(side * 0.215, -0.33, 0.752 + row * 0.015 + RIDER_LIFT),
            0.0035,
            0.125,
            MAT["black"],
            head,
            vertices=6,
        )
        whisker.rotation_euler = (
            0,
            math.radians(90 + 12 * row * side),
            math.radians(-10 * side),
        )

# Arms and feet retain the generic model's joint pivots and node names.
for side, suffix in ((-1, "L"), (1, "R")):
    shoulder = V(side * 0.245, -0.075, 0.58 + RIDER_LIFT)
    arm = sphere(
        "Arm" + suffix,
        shoulder + V(0, -0.035, -0.10),
        V(0.066, 0.065, 0.125),
        MAT["cream"],
        body,
        pivot=shoulder,
        detail=0.85,
    )
    sphere(
        "Hand" + suffix,
        shoulder + V(0, -0.075, -0.20),
        V(0.061, 0.068, 0.055),
        MAT["black"],
        arm,
        detail=0.75,
    )
    arm.rotation_euler.x = -0.64

for side, suffix in ((-1, "L"), (1, "R")):
    hip = V(side * 0.13, 0, 0.18 + RIDER_LIFT)
    leg = sphere(
        "Leg" + suffix,
        hip + V(0, 0, -0.075),
        V(0.085, 0.092, 0.09),
        MAT["cream"],
        body,
        pivot=hip,
        detail=0.8,
    )
    sphere(
        "Foot" + suffix,
        hip + V(0, -0.075, -0.145),
        V(0.082, 0.135, 0.047),
        MAT["black"],
        leg,
        detail=0.8,
    )

# Scarf collar, knot, and two windswept ribbons.  The separate Scarf node gives
# runtime code a clean target if a later wind or transition animation is added.
scarf = empty("Scarf", V(0, 0, 0.69 + RIDER_LIFT), body)
sphere(
    "ScarfCollar",
    V(0, -0.005, 0.69 + RIDER_LIFT),
    V(0.315, 0.278, 0.060),
    MAT["black"],
    scarf,
)
sphere(
    "ScarfKnot",
    V(0.285, -0.035, 0.705 + RIDER_LIFT),
    V(0.075, 0.068, 0.072),
    MAT["black"],
    scarf,
    detail=0.8,
)
ribbon(
    "ScarfTailUpper",
    [
        (0.31, -0.005, 0.73 + RIDER_LIFT),
        (0.47, -0.005, 0.76 + RIDER_LIFT),
        (0.64, 0.0, 0.745 + RIDER_LIFT),
        (0.79, 0.005, 0.79 + RIDER_LIFT),
    ],
    [0.12, 0.13, 0.12, 0.08],
    0.055,
    MAT["black"],
    scarf,
    V(0.31, -0.005, 0.73 + RIDER_LIFT),
)
ribbon(
    "ScarfTailLower",
    [
        (0.30, 0.015, 0.68 + RIDER_LIFT),
        (0.44, 0.02, 0.61 + RIDER_LIFT),
        (0.58, 0.018, 0.59 + RIDER_LIFT),
        (0.70, 0.02, 0.63 + RIDER_LIFT),
    ],
    [0.12, 0.14, 0.12, 0.075],
    0.055,
    MAT["black"],
    scarf,
    V(0.30, 0.015, 0.68 + RIDER_LIFT),
)


# -----------------------------------------------------------------------------
# Cloud variant
# -----------------------------------------------------------------------------

if VARIANT == "cloud":
    cloud = empty("Cloud", V(0, 0, 0.18), root)
    # A broad central cushion closes the bottom so the cloud reads as one solid,
    # opaque volume rather than a see-through ring of spheres.
    sphere(
        "CloudBase",
        V(0, 0.015, 0.17),
        V(0.49, 0.34, 0.16),
        MAT["cloud"],
        cloud,
        detail=1.05,
    )
    puffs = [
        (-0.38, -0.02, 0.18, 0.19, 0.18, 0.17),
        (-0.23, -0.10, 0.25, 0.22, 0.19, 0.21),
        (-0.06, -0.12, 0.24, 0.23, 0.20, 0.21),
        (0.13, -0.12, 0.25, 0.24, 0.20, 0.22),
        (0.32, -0.07, 0.22, 0.21, 0.19, 0.19),
        (0.43, 0.05, 0.17, 0.17, 0.17, 0.15),
        (0.27, 0.17, 0.20, 0.23, 0.20, 0.18),
        (0.05, 0.19, 0.22, 0.25, 0.21, 0.20),
        (-0.19, 0.18, 0.20, 0.23, 0.20, 0.18),
        (-0.39, 0.10, 0.16, 0.18, 0.17, 0.15),
    ]
    for index, (x, y, z, rx, ry, rz) in enumerate(puffs, start=1):
        sphere(
            f"CloudPuff{index:02d}",
            V(x, y, z),
            V(rx, ry, rz),
            MAT["cloud"],
            cloud,
            detail=0.95,
        )


# -----------------------------------------------------------------------------
# Validation, editable source, export
# -----------------------------------------------------------------------------

bpy.context.view_layer.update()
lo = Vector((1e9, 1e9, 1e9))
hi = Vector((-1e9, -1e9, -1e9))
mesh_count = 0
for obj in PIVOT:
    if obj.type != "MESH":
        continue
    mesh_count += 1
    for vertex in obj.data.vertices:
        world = obj.matrix_world @ vertex.co
        lo = Vector(map(min, lo, world))
        hi = Vector(map(max, hi, world))
print(
    "SCARF_GOPHER_BOUNDS",
    f"variant={VARIANT}",
    f"min={tuple(round(value, 3) for value in lo)}",
    f"max={tuple(round(value, 3) for value in hi)}",
    f"meshes={mesh_count}",
)

if OUT_BLEND:
    target = os.path.abspath(OUT_BLEND)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=target)
    print("SCARF_GOPHER_BLEND", target)

if OUT_GLB:
    target = os.path.abspath(OUT_GLB)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in PIVOT:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=target,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_texcoords=False,
        export_materials="EXPORT",
    )
    print("SCARF_GOPHER_EXPORTED", target)


# -----------------------------------------------------------------------------
# Preview renders
# -----------------------------------------------------------------------------

if RENDER_PREFIX:
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 700
    scene.render.resolution_y = 700
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.look = "Medium High Contrast"

    world = bpy.data.worlds.new("PreviewWorld")
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = (0.64, 0.69, 0.76, 1.0)
    background.inputs["Strength"].default_value = 0.75

    floor_mat = material("PreviewFloor", (0.70, 0.74, 0.79), 0.95)
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, -0.002))
    floor = bpy.context.active_object
    floor.name = "PreviewFloor"
    floor.data.materials.append(floor_mat)

    sun_data = bpy.data.lights.new("PreviewSun", type="SUN")
    sun_data.energy = 3.2
    sun_data.angle = math.radians(8)
    sun = bpy.data.objects.new("PreviewSun", sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (
        math.radians(48),
        math.radians(-20),
        math.radians(-30),
    )

    fill_data = bpy.data.lights.new("PreviewFill", type="AREA")
    fill_data.energy = 300
    fill_data.shape = "DISK"
    fill_data.size = 4.0
    fill = bpy.data.objects.new("PreviewFill", fill_data)
    scene.collection.objects.link(fill)
    fill.location = (-2.5, -2.4, 3.0)
    fill.rotation_euler = (
        Vector((0, 0, 0.6 + RIDER_LIFT * 0.5)) - fill.location
    ).to_track_quat("-Z", "Y").to_euler()

    rim_data = bpy.data.lights.new("PreviewRim", type="AREA")
    rim_data.energy = 210
    rim_data.size = 3.0
    rim = bpy.data.objects.new("PreviewRim", rim_data)
    scene.collection.objects.link(rim)
    rim.location = (2.2, 1.8, 2.5)
    rim.rotation_euler = (
        Vector((0, 0, 0.7 + RIDER_LIFT * 0.5)) - rim.location
    ).to_track_quat("-Z", "Y").to_euler()

    camera_data = bpy.data.cameras.new("PreviewCamera")
    camera_data.lens = 58
    camera = bpy.data.objects.new("PreviewCamera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    target = Vector((0.10, 0, (0.57 + RIDER_LIFT * 0.5) * S))
    distance = 3.15 if VARIANT == "plain" else 3.45
    views = {
        "front34": Vector((1.65, -distance, 1.20 + RIDER_LIFT * 0.45)),
        "front": Vector((0.12, -distance, 0.94 + RIDER_LIFT * 0.45)),
        "side": Vector((distance, -0.05, 0.94 + RIDER_LIFT * 0.45)),
        "back34": Vector((-1.65, distance, 1.20 + RIDER_LIFT * 0.45)),
    }
    for view_name, position in views.items():
        camera.location = position
        camera.rotation_euler = (target - position).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.abspath(
            f"{RENDER_PREFIX}-{view_name}.png"
        )
        bpy.ops.render.render(write_still=True)
        print("SCARF_GOPHER_RENDERED", scene.render.filepath)
