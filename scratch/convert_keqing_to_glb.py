import struct
import json
import os

def convert_pmd_to_glb(pmd_path, texture_dir, output_glb_path):
    print(f"Reading PMD: {pmd_path}")
    with open(pmd_path, "rb") as f:
        magic = f.read(3)
        assert magic == b"Pmd", f"Invalid magic: {magic}"
        version = struct.unpack("<f", f.read(4))[0]
        name = f.read(20).decode("shift_jis", errors="ignore").strip("\x00")
        comment = f.read(256).decode("shift_jis", errors="ignore").strip("\x00")
        print(f"Model: {name}, version: {version}")

        # 1. Vertices
        num_verts = struct.unpack("<I", f.read(4))[0]
        print(f"Loading {num_verts} vertices...")
        positions = []
        normals = []
        uvs = []

        min_pos = [float("inf"), float("inf"), float("inf")]
        max_pos = [float("-inf"), float("-inf"), float("-inf")]

        for _ in range(num_verts):
            x, y, z, nx, ny, nz, u, v = struct.unpack("<8f", f.read(32))
            f.read(6) # bones & edge
            gx, gy, gz = x, y, -z
            gnx, gny, gnz = nx, ny, -nz
            gu, gv = u, v

            positions.extend([gx, gy, gz])
            normals.extend([gnx, gny, gnz])
            uvs.extend([gu, gv])

            min_pos[0] = min(min_pos[0], gx)
            min_pos[1] = min(min_pos[1], gy)
            min_pos[2] = min(min_pos[2], gz)
            max_pos[0] = max(max_pos[0], gx)
            max_pos[1] = max(max_pos[1], gy)
            max_pos[2] = max(max_pos[2], gz)

        print(f"Bounds: min={min_pos}, max={max_pos}")

        # 2. Indices
        num_indices = struct.unpack("<I", f.read(4))[0]
        print(f"Loading {num_indices} indices...")
        raw_indices = struct.unpack(f"<{num_indices}H", f.read(num_indices * 2))

        # 3. Materials
        num_mats = struct.unpack("<I", f.read(4))[0]
        print(f"Loading {num_mats} materials...")
        materials_pmd = []
        for i in range(num_mats):
            diffuse = struct.unpack("<4f", f.read(16))
            shininess = struct.unpack("<f", f.read(4))[0]
            specular = struct.unpack("<3f", f.read(12))
            ambient = struct.unpack("<3f", f.read(12))
            toon = struct.unpack("<B", f.read(1))[0]
            edge = struct.unpack("<B", f.read(1))[0]
            face_cnt = struct.unpack("<I", f.read(4))[0]
            tex_raw = f.read(20)
            tex_str = tex_raw.split(b"\x00")[0].decode("shift_jis", errors="ignore")
            # clean texture name
            tex_clean = tex_str.split("*")[0].replace("\\", "/").split("/")[-1]
            materials_pmd.append({
                "index": i,
                "diffuse": diffuse,
                "face_cnt": face_cnt,
                "tex_filename": tex_clean
            })

    # Slice indices per material and flip triangle winding (i0, i2, i1)
    material_indices = []
    idx_offset = 0
    for mat in materials_pmd:
        cnt = mat["face_cnt"]
        chunk = raw_indices[idx_offset : idx_offset + cnt]
        idx_offset += cnt
        # flip winding
        flipped = []
        for t in range(0, cnt, 3):
            flipped.extend([chunk[t], chunk[t+2], chunk[t+1]])
        material_indices.append(flipped)

    # Collect distinct textures
    tex_files = []
    for m in materials_pmd:
        fn = m["tex_filename"]
        if fn and fn not in tex_files:
            tex_files.append(fn)

    print(f"Textures used: {tex_files}")
    tex_to_image_idx = {fn: i for i, fn in enumerate(tex_files)}

    # Build binary buffers
    bin_chunks = []
    buffer_views = []
    accessors = []

    def add_buffer_data(data_bytes, target=None):
        # align to 4 bytes
        pad = (4 - (len(data_bytes) % 4)) % 4
        padded = data_bytes + (b"\x00" * pad)
        offset = sum(len(c) for c in bin_chunks)
        bv_idx = len(buffer_views)
        bv_entry = {
            "buffer": 0,
            "byteOffset": offset,
            "byteLength": len(data_bytes),
        }
        if target:
            bv_entry["target"] = target
        buffer_views.append(bv_entry)
        bin_chunks.append(padded)
        return bv_idx

    # BufferView 0: Positions
    pos_bytes = struct.pack(f"<{len(positions)}f", *positions)
    bv_pos = add_buffer_data(pos_bytes, target=34962)
    acc_pos = len(accessors)
    accessors.append({
        "bufferView": bv_pos,
        "byteOffset": 0,
        "componentType": 5126, # FLOAT
        "count": num_verts,
        "type": "VEC3",
        "min": min_pos,
        "max": max_pos
    })

    # BufferView 1: Normals
    norm_bytes = struct.pack(f"<{len(normals)}f", *normals)
    bv_norm = add_buffer_data(norm_bytes, target=34962)
    acc_norm = len(accessors)
    accessors.append({
        "bufferView": bv_norm,
        "byteOffset": 0,
        "componentType": 5126, # FLOAT
        "count": num_verts,
        "type": "VEC3"
    })

    # BufferView 2: UVs
    uv_bytes = struct.pack(f"<{len(uvs)}f", *uvs)
    bv_uv = add_buffer_data(uv_bytes, target=34962)
    acc_uv = len(accessors)
    accessors.append({
        "bufferView": bv_uv,
        "byteOffset": 0,
        "componentType": 5126, # FLOAT
        "count": num_verts,
        "type": "VEC2"
    })

    # BufferViews and Accessors for Indices per material
    mat_index_accessors = []
    for i, indices in enumerate(material_indices):
        idx_bytes = struct.pack(f"<{len(indices)}H", *indices)
        bv_idx = add_buffer_data(idx_bytes, target=34963)
        acc_idx = len(accessors)
        accessors.append({
            "bufferView": bv_idx,
            "byteOffset": 0,
            "componentType": 5123, # UNSIGNED_SHORT
            "count": len(indices),
            "type": "SCALAR",
            "min": [min(indices)],
            "max": [max(indices)]
        })
        mat_index_accessors.append(acc_idx)

    # BufferViews for Images
    images_gltf = []
    textures_gltf = []
    for i, fn in enumerate(tex_files):
        img_path = os.path.join(texture_dir, fn)
        with open(img_path, "rb") as img_f:
            img_data = img_f.read()
        bv_img = add_buffer_data(img_data)
        images_gltf.append({
            "bufferView": bv_img,
            "mimeType": "image/png"
        })
        textures_gltf.append({
            "sampler": 0,
            "source": i
        })

    # Materials in glTF
    gltf_materials = []
    for i, m in enumerate(materials_pmd):
        fn = m["tex_filename"]
        tex_idx = tex_to_image_idx.get(fn)
        mat_def = {
            "name": f"Mat_{i}_{fn.split('.')[0]}",
            "pbrMetallicRoughness": {
                "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                "metallicFactor": 0.05,
                "roughnessFactor": 0.45
            },
            "doubleSided": True
        }
        if tex_idx is not None:
            mat_def["pbrMetallicRoughness"]["baseColorTexture"] = {"index": tex_idx}

        # Alpha mode
        if "表情" in fn:
            mat_def["alphaMode"] = "BLEND"
        elif "服" in fn:
            mat_def["alphaMode"] = "MASK"
            mat_def["alphaCutoff"] = 0.5
        elif "肌" in fn:
            mat_def["alphaMode"] = "OPAQUE"
        else:
            mat_def["alphaMode"] = "OPAQUE"

        gltf_materials.append(mat_def)

    # Primitives for the single mesh
    primitives = []
    for i, m in enumerate(materials_pmd):
        primitives.append({
            "attributes": {
                "POSITION": acc_pos,
                "NORMAL": acc_norm,
                "TEXCOORD_0": acc_uv
            },
            "indices": mat_index_accessors[i],
            "material": i
        })

    total_bin_data = b"".join(bin_chunks)

    gltf_dict = {
        "asset": {
            "version": "2.0",
            "generator": "Official Genshin PMD to GLB"
        },
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "Keqing"}],
        "meshes": [{
            "name": "KeqingMesh",
            "primitives": primitives
        }],
        "materials": gltf_materials,
        "textures": textures_gltf,
        "images": images_gltf,
        "samplers": [{
            "magFilter": 9729,
            "minFilter": 9987,
            "wrapS": 10497,
            "wrapT": 10497
        }],
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{
            "byteLength": len(total_bin_data)
        }]
    }

    json_str = json.dumps(gltf_dict, separators=(',', ':'))
    json_bytes = json_str.encode("utf-8")
    # Pad json_bytes with spaces to 4-byte boundary
    pad_json = (4 - (len(json_bytes) % 4)) % 4
    json_bytes += b" " * pad_json

    # Assemble GLB
    # Header: magic (4), version (4), length (4)
    glb_len = 12 + 8 + len(json_bytes) + 8 + len(total_bin_data)
    header = struct.pack("<4sII", b"glTF", 2, glb_len)

    # JSON Chunk header: chunkLength (4), chunkType (4)
    json_chunk_hdr = struct.pack("<I4s", len(json_bytes), b"JSON")

    # BIN Chunk header: chunkLength (4), chunkType (4)
    bin_chunk_hdr = struct.pack("<I4s", len(total_bin_data), b"BIN\x00")

    with open(output_glb_path, "wb") as out:
        out.write(header)
        out.write(json_chunk_hdr)
        out.write(json_bytes)
        out.write(bin_chunk_hdr)
        out.write(total_bin_data)

    print(f"Successfully wrote {output_glb_path} ({glb_len} bytes, {glb_len/(1024*1024):.2f} MB)")

if __name__ == "__main__":
    convert_pmd_to_glb(
        "scratch/genshin_keqing/keqing.pmd",
        "scratch/genshin_keqing/K_Texture",
        "scratch/test_keqing.glb"
    )
