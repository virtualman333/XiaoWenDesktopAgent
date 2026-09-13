"""生成小问助手的应用图标 (icon.ico)"""
import struct, zlib, os

def make_png(size):
    """生成一个蓝色渐变圆角方块 + 白色『问』字的 PNG"""
    W = H = size
    px = [[(0,0,0,0)] * W for _ in range(H)]

    r = size * 0.28          # 圆角半径
    cx = cy = size / 2
    for y in range(H):
        for x in range(W):
            # 圆角矩形 alpha
            dx = max(0, abs(x + .5 - cx) - (size/2 - r))
            dy = max(0, abs(y + .5 - cy) - (size/2 - r))
            inside = (dx*dx + dy*dy) <= r*r
            if not inside:
                continue
            # 对角线性渐变 #5b9dff -> #3b6fe0 -> #7c5cf6
            t = (x + y) / (W + H)
            if t < 0.5:
                u = t / 0.5
                c = (int(91 + (59-91)*u), int(157 + (111-157)*u), int(255 + (224-255)*u))
            else:
                u = (t - 0.5) / 0.5
                c = (int(59 + (124-59)*u), int(111 + (92-111)*u), int(224 + (246-224)*u))
            px[y][x] = (c[0], c[1], c[2], 255)

    # 画白色『问』字（用简单笔画近似，避免依赖字体）
    # 采用一个大的圆环 + 竖钩，视觉上接近问号
    def put(x, y, a=255):
        if 0 <= x < W and 0 <= y < H:
            px[int(y)][int(x)] = (255, 255, 255, a)

    cx2 = size / 2
    # 问号上半部圆环
    ring_cy = size * 0.40
    ring_r_out = size * 0.175
    ring_r_in = size * 0.105
    for y in range(H):
        for x in range(W):
            d = ((x + .5 - cx2)**2 + (y + .5 - ring_cy)**2) ** 0.5
            if ring_r_in <= d <= ring_r_out:
                # 只保留上半环 + 右侧下垂
                put(x, y)

    # 下半竖线
    bar_w = size * 0.075
    y0, y1 = size * 0.545, size * 0.66
    for y in range(int(y0), int(y1)):
        for x in range(int(cx2 - bar_w/2), int(cx2 + bar_w/2)):
            put(x, y)

    # 底部圆点
    dot_cy = size * 0.775
    dot_r = size * 0.058
    for y in range(H):
        for x in range(W):
            if ((x + .5 - cx2)**2 + (y + .5 - dot_cy)**2) ** 0.5 <= dot_r:
                put(x, y)

    raw = b''
    for y in range(H):
        raw += b'\x00'
        for x in range(W):
            raw += bytes(px[y][x])

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    return png

def make_ico(path, sizes=(16, 24, 32, 48, 64, 128, 256)):
    pngs = [(s, make_png(s)) for s in sizes]
    n = len(pngs)
    header = struct.pack('<HHH', 0, 1, n)
    offset = 6 + n * 16
    entries = b''
    data = b''
    for s, png in pngs:
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        entries += struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(png), offset)
        offset += len(png)
        data += png
    with open(path, 'wb') as f:
        f.write(header + entries + data)

if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icon.ico')
    make_ico(out)
    print('OK ->', out, os.path.getsize(out), 'bytes')
