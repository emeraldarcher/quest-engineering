#!/usr/bin/env python3
"""Join two equal-height RGBA8 PNG screenshots without external dependencies."""
import sys, struct, zlib, binascii

sys.path.insert(0, "client/scripts")
from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location("png", "client/scripts/composite-png.py")
png = module_from_spec(spec)
spec.loader.exec_module(png)

def chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", binascii.crc32(kind + body) & 0xffffffff)

def main(left_path, right_path, out_path):
    lw, lh, left = png.read_png(left_path)
    rw, rh, right = png.read_png(right_path)
    if lh != rh:
        raise ValueError("Screenshots must have equal heights")
    divider = 8
    width = lw + divider + rw
    raw = bytearray()
    for y in range(lh):
        raw.append(0)
        raw.extend(left[y])
        raw.extend(bytes((43, 55, 56, 255)) * divider)
        raw.extend(right[y])
    output = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, lh, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    open(out_path, "wb").write(output)

if __name__ == "__main__":
    main(*sys.argv[1:])
