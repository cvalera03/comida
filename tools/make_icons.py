#!/usr/bin/env python3
"""Genera los iconos PNG de la app (solo librería estándar). Uso: python3 tools/make_icons.py"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "icons")
BG = (46, 125, 91)
WHITE = (255, 255, 255)


def shade(x, y):
    """Devuelve (color, alpha) de la figura en coordenadas normalizadas 0..1."""
    # Táper: cuerpo redondeado
    bx0, bx1, by0, by1, r = 0.22, 0.78, 0.47, 0.78, 0.07
    cx = min(max(x, bx0 + r), bx1 - r)
    cy = min(max(y, by0 + r), by1 - r)
    if bx0 <= x <= bx1 and by0 <= y <= by1 and math.hypot(x - cx, y - cy) <= r:
        return WHITE
    # Tapa
    if 0.18 <= x <= 0.82 and 0.39 <= y <= 0.44:
        return WHITE
    if 0.44 <= x <= 0.56 and 0.34 <= y <= 0.40:
        return WHITE
    # Vapor: tres ondas
    for ox in (0.36, 0.5, 0.64):
        if 0.14 <= y <= 0.30:
            wx = ox + 0.025 * math.sin((y - 0.14) / 0.16 * 2 * math.pi)
            if abs(x - wx) <= 0.018:
                return WHITE
    return None


def render(size, rounded):
    ss = 3
    rows = []
    rad = 0.2237 * size
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss)
                    y = (py + (sy + 0.5) / ss)
                    inside = True
                    if rounded:
                        cx = min(max(x, rad), size - rad)
                        cy = min(max(y, rad), size - rad)
                        inside = math.hypot(x - cx, y - cy) <= rad
                    if not inside:
                        continue
                    c = shade(x / size, y / size) or BG
                    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
            n = ss * ss
            a = acc[3] / n
            if a:
                w = acc[3] / 255  # nº de submuestras cubiertas
                row += bytes([int(acc[0] / w), int(acc[1] / w), int(acc[2] / w), int(a)])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


os.makedirs(OUT, exist_ok=True)
# iOS aplica su propia máscara redondeada: el apple-touch-icon va cuadrado y opaco.
for name, size, rounded in [("apple-touch-icon.png", 180, False), ("icon-192.png", 192, True), ("icon-512.png", 512, False)]:
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(render(size, rounded))
    print("ok", name)
