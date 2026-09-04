"""Dependency-free fallback exporter for the scarf gopher GLBs.

The canonical editable model remains gopher_scarf.py.  This exporter mirrors
that procedural design closely enough to produce game-ready GLBs on headless
macOS workers where Blender cannot initialize a Metal device.
"""

import argparse
import json
import math
import os
import struct
from dataclasses import dataclass


S = 0.89


def v(x, y, z):
    return (x * S, y * S, z * S)


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def mul(a, scalar):
    return (a[0] * scalar, a[1] * scalar, a[2] * scalar)


def cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def normalize(a):
    length = math.sqrt(a[0] ** 2 + a[1] ** 2 + a[2] ** 2)
    if length < 1e-10:
        return (0.0, 0.0, 1.0)
    return (a[0] / length, a[1] / length, a[2] / length)


def to_gltf(a):
    """Blender Z-up/front -Y -> glTF Y-up/front +Z."""
    return (a[0], a[2], -a[1])


@dataclass
class MeshData:
    positions: list
    normals: list
    indices: list


def sphere(center, radii, segments=24, rings=14):
    positions = []
    normals = []
    indices = []
    for row in range(rings + 1):
        latitude = -math.pi / 2 + math.pi * row / rings
        ring = math.cos(latitude)
        sin_lat = math.sin(latitude)
        for col in range(segments):
            theta = 2 * math.pi * col / segments
            unit = (ring * math.cos(theta), ring * math.sin(theta), sin_lat)
            positions.append(
                (
                    center[0] + radii[0] * unit[0],
                    center[1] + radii[1] * unit[1],
                    center[2] + radii[2] * unit[2],
                )
            )
            normals.append(
                normalize(
                    (
                        unit[0] / radii[0],
                        unit[1] / radii[1],
                        unit[2] / radii[2],
                    )
                )
            )
    for row in range(rings):
        for col in range(segments):
            nxt = (col + 1) % segments
            a = row * segments + col
            b = row * segments + nxt
            c = (row + 1) * segments + nxt
            d = (row + 1) * segments + col
            if row != 0:
                indices.extend((a, b, d))
            if row != rings - 1:
                indices.extend((b, c, d))
    return MeshData(positions, normals, indices)


def ellipsoid_band(center, radii, lat_bottom, lat_top, segments=36, rows=4):
    positions = []
    normals = []
    indices = []
    expanded = tuple(value * 1.012 for value in radii)
    for row in range(rows + 1):
        latitude = math.radians(
            lat_bottom + (lat_top - lat_bottom) * row / rows
        )
        ring = math.cos(latitude)
        sin_lat = math.sin(latitude)
        for col in range(segments):
            theta = 2 * math.pi * col / segments
            unit = (ring * math.cos(theta), ring * math.sin(theta), sin_lat)
            positions.append(
                (
                    center[0] + expanded[0] * unit[0],
                    center[1] + expanded[1] * unit[1],
                    center[2] + expanded[2] * unit[2],
                )
            )
            normals.append(
                normalize(
                    (
                        unit[0] / expanded[0],
                        unit[1] / expanded[1],
                        unit[2] / expanded[2],
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
            indices.extend((a, b, d, b, c, d))
    return MeshData(positions, normals, indices)


def flat_mesh(vertices, faces):
    positions = []
    normals = []
    indices = []
    for face in faces:
        anchor = vertices[face[0]]
        normal = normalize(
            cross(sub(vertices[face[1]], anchor), sub(vertices[face[2]], anchor))
        )
        start = len(positions)
        for index in face:
            positions.append(vertices[index])
            normals.append(normal)
        for offset in range(1, len(face) - 1):
            indices.extend((start, start + offset, start + offset + 1))
    return MeshData(positions, normals, indices)


def box(center, size):
    hx, hy, hz = (value * 0.5 for value in size)
    x, y, z = center
    vertices = [
        (x - hx, y - hy, z - hz),
        (x + hx, y - hy, z - hz),
        (x + hx, y + hy, z - hz),
        (x - hx, y + hy, z - hz),
        (x - hx, y - hy, z + hz),
        (x + hx, y - hy, z + hz),
        (x + hx, y + hy, z + hz),
        (x - hx, y + hy, z + hz),
    ]
    faces = [
        (0, 3, 2, 1),
        (4, 5, 6, 7),
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
    ]
    return flat_mesh(vertices, faces)


def ribbon(points, widths, thickness):
    vertices = []
    faces = []
    half_depth = thickness * S * 0.5
    for point, width in zip(points, widths):
        point = v(*point)
        half_width = width * S * 0.5
        vertices.extend(
            [
                add(point, (0, -half_depth, half_width)),
                add(point, (0, half_depth, half_width)),
                add(point, (0, -half_depth, -half_width)),
                add(point, (0, half_depth, -half_width)),
            ]
        )
    for index in range(len(points) - 1):
        a = index * 4
        b = (index + 1) * 4
        faces.extend(
            [
                (a, b, b + 2, a + 2),
                (a + 1, a + 3, b + 3, b + 1),
                (a, a + 1, b + 1, b),
                (a + 2, b + 2, b + 3, a + 3),
            ]
        )
    end = len(vertices) - 4
    faces.extend(((0, 2, 3, 1), (end, end + 1, end + 3, end + 2)))
    return flat_mesh(vertices, faces)


def cylinder_between(start, end, radius, segments=8):
    axis = normalize(sub(end, start))
    helper = (0.0, 0.0, 1.0) if abs(axis[2]) < 0.9 else (0.0, 1.0, 0.0)
    tangent = normalize(cross(axis, helper))
    bitangent = normalize(cross(axis, tangent))
    positions = []
    normals = []
    indices = []
    for endpoint in (start, end):
        for index in range(segments):
            angle = 2 * math.pi * index / segments
            normal = add(mul(tangent, math.cos(angle)), mul(bitangent, math.sin(angle)))
            positions.append(add(endpoint, mul(normal, radius * S)))
            normals.append(normal)
    for index in range(segments):
        nxt = (index + 1) % segments
        indices.extend((index, nxt, segments + index, nxt, segments + nxt, segments + index))
    return MeshData(positions, normals, indices)


class GLBBuilder:
    def __init__(self):
        self.binary = bytearray()
        self.buffer_views = []
        self.accessors = []
        self.meshes = []
        self.nodes = []
        self.world_pivots = []
        self.materials = []
        self.material_lookup = {}
        self.roots = []

    def material(self, name, rgba, roughness):
        if name in self.material_lookup:
            return self.material_lookup[name]
        index = len(self.materials)
        self.material_lookup[name] = index
        self.materials.append(
            {
                "name": name,
                "pbrMetallicRoughness": {
                    "baseColorFactor": list(rgba),
                    "metallicFactor": 0.0,
                    "roughnessFactor": roughness,
                },
                "alphaMode": "OPAQUE",
                "doubleSided": True,
            }
        )
        return index

    def _align(self):
        while len(self.binary) % 4:
            self.binary.append(0)

    def accessor(self, values, component_type, type_name, target, include_bounds=False):
        self._align()
        offset = len(self.binary)
        components = {"SCALAR": 1, "VEC3": 3}[type_name]
        flat = []
        if components == 1:
            flat = values
        else:
            for value in values:
                flat.extend(value)
        if component_type == 5126:
            payload = struct.pack("<" + "f" * len(flat), *flat)
        elif component_type == 5123:
            payload = struct.pack("<" + "H" * len(flat), *flat)
        else:
            payload = struct.pack("<" + "I" * len(flat), *flat)
        self.binary.extend(payload)
        view_index = len(self.buffer_views)
        self.buffer_views.append(
            {
                "buffer": 0,
                "byteOffset": offset,
                "byteLength": len(payload),
                "target": target,
            }
        )
        accessor = {
            "bufferView": view_index,
            "byteOffset": 0,
            "componentType": component_type,
            "count": len(values),
            "type": type_name,
        }
        if include_bounds:
            accessor["min"] = [min(value[axis] for value in values) for axis in range(3)]
            accessor["max"] = [max(value[axis] for value in values) for axis in range(3)]
        accessor_index = len(self.accessors)
        self.accessors.append(accessor)
        return accessor_index

    def add_node(self, name, pivot, parent=None, mesh=None, material=None):
        node = {"name": name}
        if parent is None:
            translation = pivot
        else:
            translation = sub(pivot, self.world_pivots[parent])
        converted_translation = to_gltf(translation)
        if any(abs(value) > 1e-9 for value in converted_translation):
            node["translation"] = list(converted_translation)

        if mesh is not None:
            local_positions = [to_gltf(sub(position, pivot)) for position in mesh.positions]
            local_normals = [to_gltf(normal) for normal in mesh.normals]
            position_accessor = self.accessor(
                local_positions, 5126, "VEC3", 34962, include_bounds=True
            )
            normal_accessor = self.accessor(local_normals, 5126, "VEC3", 34962)
            component = 5123 if max(mesh.indices, default=0) < 65536 else 5125
            index_accessor = self.accessor(mesh.indices, component, "SCALAR", 34963)
            mesh_index = len(self.meshes)
            self.meshes.append(
                {
                    "name": name,
                    "primitives": [
                        {
                            "attributes": {
                                "POSITION": position_accessor,
                                "NORMAL": normal_accessor,
                            },
                            "indices": index_accessor,
                            "material": material,
                        }
                    ],
                }
            )
            node["mesh"] = mesh_index

        node_index = len(self.nodes)
        self.nodes.append(node)
        self.world_pivots.append(pivot)
        if parent is None:
            self.roots.append(node_index)
        else:
            self.nodes[parent].setdefault("children", []).append(node_index)
        return node_index

    def write(self, path, generator):
        document = {
            "asset": {"version": "2.0", "generator": generator},
            "scene": 0,
            "scenes": [{"name": "Scene", "nodes": self.roots}],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": self.materials,
            "accessors": self.accessors,
            "bufferViews": self.buffer_views,
            "buffers": [{"byteLength": len(self.binary)}],
        }
        json_bytes = json.dumps(document, separators=(",", ":")).encode("utf-8")
        while len(json_bytes) % 4:
            json_bytes += b" "
        self._align()
        binary = bytes(self.binary)
        total_length = 12 + 8 + len(json_bytes) + 8 + len(binary)
        glb = bytearray(struct.pack("<4sII", b"glTF", 2, total_length))
        glb.extend(struct.pack("<I4s", len(json_bytes), b"JSON"))
        glb.extend(json_bytes)
        glb.extend(struct.pack("<I4s", len(binary), b"BIN\x00"))
        glb.extend(binary)
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(glb)


def build(variant, output):
    lift = 0.31 if variant == "cloud" else 0.0
    builder = GLBBuilder()
    cream = builder.material("CreamFur", (0.93, 0.90, 0.82, 1.0), 0.82)
    warm = builder.material("WarmFur", (0.82, 0.75, 0.63, 1.0), 0.82)
    black = builder.material("ScarfBlack", (0.012, 0.014, 0.018, 1.0), 0.58)
    eye_white = builder.material("EyeWhite", (1.0, 0.99, 0.96, 1.0), 0.25)
    tooth = builder.material("Tooth", (1.0, 0.99, 0.94, 1.0), 0.30)
    inner_ear = builder.material("InnerEar", (0.77, 0.58, 0.54, 1.0), 0.78)
    cloud_white = builder.material("OpaqueCloud", (1.0, 1.0, 1.0, 1.0), 0.94)

    root = builder.add_node("Gopher", v(0, 0, 0))
    character = builder.add_node("Character", v(0, 0, lift), root)

    body_center = v(0, 0, 0.42 + lift)
    body_radii = v(0.30, 0.255, 0.35)
    body = builder.add_node(
        "Body", body_center, character, sphere(body_center, body_radii), cream
    )
    builder.add_node(
        "StripeLower",
        body_center,
        body,
        ellipsoid_band(body_center, body_radii, -38, -14),
        black,
    )
    builder.add_node(
        "StripeUpper",
        body_center,
        body,
        ellipsoid_band(body_center, body_radii, 7, 29),
        black,
    )
    tail_pivot = v(0, 0.22, 0.36 + lift)
    builder.add_node(
        "Tail",
        tail_pivot,
        body,
        sphere(v(0, 0.265, 0.36 + lift), v(0.075, 0.08, 0.07), 18, 10),
        warm,
    )

    head_pivot = v(0, -0.02, 0.61 + lift)
    head_center = v(0, -0.04, 0.82 + lift)
    head = builder.add_node(
        "Head", head_pivot, body, sphere(head_center, v(0.325, 0.30, 0.31)), cream
    )
    for side, suffix in ((-1, "L"), (1, "R")):
        ear_center = v(side * 0.255, 0.015, 1.02 + lift)
        ear = builder.add_node(
            "Ear" + suffix,
            ear_center,
            head,
            sphere(ear_center, v(0.073, 0.066, 0.073), 18, 10),
            cream,
        )
        inner_center = add(ear_center, v(0, -0.035, 0))
        builder.add_node(
            "Ear" + suffix + "Inner",
            inner_center,
            ear,
            sphere(inner_center, v(0.042, 0.024, 0.043), 16, 9),
            inner_ear,
        )

    muzzle_center = v(0, -0.294, 0.755 + lift)
    builder.add_node(
        "Muzzle", muzzle_center, head, sphere(muzzle_center, v(0.145, 0.095, 0.115)), warm
    )
    nose_center = v(0, -0.392, 0.80 + lift)
    builder.add_node(
        "Nose",
        nose_center,
        head,
        sphere(nose_center, v(0.039, 0.031, 0.034), 16, 9),
        black,
    )
    for side, suffix in ((-1, "L"), (1, "R")):
        center = v(side * 0.025, -0.365, 0.675 + lift)
        builder.add_node(
            "Tooth" + suffix,
            center,
            head,
            box(center, v(0.043, 0.027, 0.072)),
            tooth,
        )

    for side, suffix in ((-1, "L"), (1, "R")):
        eye_center = v(side * 0.135, -0.278, 0.89 + lift)
        eye = builder.add_node(
            "Eye" + suffix,
            eye_center,
            head,
            sphere(eye_center, v(0.092, 0.066, 0.106), 22, 13),
            eye_white,
        )
        outward = normalize(sub(eye_center, head_center))
        pupil_center = add(add(eye_center, mul(outward, 0.050 * S)), v(0.018, -0.006, 0.015))
        pupil = builder.add_node(
            "Eye" + suffix + "Pupil",
            pupil_center,
            eye,
            sphere(pupil_center, v(0.049, 0.031, 0.060), 18, 10),
            black,
        )
        shine_center = add(add(pupil_center, mul(outward, 0.029 * S)), v(-0.012, -0.006, 0.021))
        builder.add_node(
            "Eye" + suffix + "Shine",
            shine_center,
            pupil,
            sphere(shine_center, v(0.014, 0.010, 0.016), 12, 7),
            eye_white,
        )

    for side, suffix in ((-1, "L"), (1, "R")):
        for row in (-1, 0, 1):
            start = v(side * 0.185, -0.332, 0.752 + row * 0.015 + lift)
            end = v(side * 0.315, -0.342, 0.752 + row * 0.035 + lift)
            center = mul(add(start, end), 0.5)
            builder.add_node(
                f"Whisker{suffix}{row + 2}",
                center,
                head,
                cylinder_between(start, end, 0.0035, 6),
                black,
            )

    for side, suffix in ((-1, "L"), (1, "R")):
        shoulder = v(side * 0.245, -0.075, 0.58 + lift)
        arm_center = add(shoulder, v(0, -0.035, -0.10))
        arm = builder.add_node(
            "Arm" + suffix,
            shoulder,
            body,
            sphere(arm_center, v(0.066, 0.065, 0.125), 20, 11),
            cream,
        )
        hand_center = add(shoulder, v(0, -0.075, -0.20))
        builder.add_node(
            "Hand" + suffix,
            hand_center,
            arm,
            sphere(hand_center, v(0.061, 0.068, 0.055), 18, 10),
            black,
        )

    for side, suffix in ((-1, "L"), (1, "R")):
        hip = v(side * 0.13, 0, 0.18 + lift)
        leg_center = add(hip, v(0, 0, -0.075))
        leg = builder.add_node(
            "Leg" + suffix,
            hip,
            body,
            sphere(leg_center, v(0.085, 0.092, 0.09), 18, 10),
            cream,
        )
        foot_center = add(hip, v(0, -0.075, -0.145))
        builder.add_node(
            "Foot" + suffix,
            foot_center,
            leg,
            sphere(foot_center, v(0.082, 0.135, 0.047), 20, 11),
            black,
        )

    scarf_pivot = v(0, 0, 0.69 + lift)
    scarf = builder.add_node("Scarf", scarf_pivot, body)
    collar_center = v(0, -0.005, 0.69 + lift)
    builder.add_node(
        "ScarfCollar",
        collar_center,
        scarf,
        sphere(collar_center, v(0.315, 0.278, 0.060), 28, 12),
        black,
    )
    knot_center = v(0.285, -0.035, 0.705 + lift)
    builder.add_node(
        "ScarfKnot",
        knot_center,
        scarf,
        sphere(knot_center, v(0.075, 0.068, 0.072), 18, 10),
        black,
    )
    upper_points = [
        (0.31, -0.005, 0.73 + lift),
        (0.47, -0.005, 0.76 + lift),
        (0.64, 0.0, 0.745 + lift),
        (0.79, 0.005, 0.79 + lift),
    ]
    builder.add_node(
        "ScarfTailUpper",
        v(*upper_points[0]),
        scarf,
        ribbon(upper_points, [0.12, 0.13, 0.12, 0.08], 0.055),
        black,
    )
    lower_points = [
        (0.30, 0.015, 0.68 + lift),
        (0.44, 0.02, 0.61 + lift),
        (0.58, 0.018, 0.59 + lift),
        (0.70, 0.02, 0.63 + lift),
    ]
    builder.add_node(
        "ScarfTailLower",
        v(*lower_points[0]),
        scarf,
        ribbon(lower_points, [0.12, 0.14, 0.12, 0.075], 0.055),
        black,
    )

    if variant == "cloud":
        cloud = builder.add_node("Cloud", v(0, 0, 0.18), root)
        center = v(0, 0.015, 0.17)
        builder.add_node(
            "CloudBase", center, cloud, sphere(center, v(0.49, 0.34, 0.16), 28, 14), cloud_white
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
            center = v(x, y, z)
            builder.add_node(
                f"CloudPuff{index:02d}",
                center,
                cloud,
                sphere(center, v(rx, ry, rz), 22, 12),
                cloud_white,
            )

    builder.write(output, "3dtest scarf gopher procedural fallback exporter")
    print(
        "SCARF_GOPHER_FALLBACK_EXPORTED",
        f"variant={variant}",
        f"nodes={len(builder.nodes)}",
        f"meshes={len(builder.meshes)}",
        f"path={os.path.abspath(output)}",
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", choices=("plain", "cloud"), required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    build(args.variant, args.out)


if __name__ == "__main__":
    main()
