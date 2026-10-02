"""Render simulated traffic-camera video and emit YOLO-style detections for each frame."""
import shutil
import subprocess

import cv2
import numpy as np

from backend.synth.world import BIKE, CW_IN, CW_OUT, DIMS3, LANE, ROAD

PX_PER_M = 8
EXTENT = 95.0


def _tex_xform():
    """Texture pixel → ground meter."""
    s = 1 / PX_PER_M
    return np.array([[s, 0, -EXTENT], [0, -s, EXTENT], [0, 0, 1.0]])


def _to_px(pts):
    pts = np.asarray(pts, float)
    return np.column_stack([(pts[:, 0] + EXTENT) * PX_PER_M, (EXTENT - pts[:, 1]) * PX_PER_M]).astype(np.int32)


def ground_texture(kind, bike_lanes=False):
    n = int(2 * EXTENT * PX_PER_M)
    img = np.zeros((n, n, 3), np.uint8)
    img[:] = (70, 120, 75)  # grass
    walk, road = (175, 178, 180), (72, 72, 74)
    rects = []
    if kind == "intersection":
        rects = [((-ROAD - 4, -EXTENT), (ROAD + 4, EXTENT), walk), ((-EXTENT, -ROAD - 4), (EXTENT, ROAD + 4), walk),
                 ((-ROAD, -EXTENT), (ROAD, EXTENT), road), ((-EXTENT, -ROAD), (EXTENT, ROAD), road)]
    else:
        rects = [((-EXTENT, -ROAD - 4), (EXTENT, ROAD + 4), walk), ((-EXTENT, -ROAD), (EXTENT, ROAD), road)]
    for (x0, y0), (x1, y1), c in rects:
        p = _to_px([[x0, y1], [x1, y0]])
        cv2.rectangle(img, tuple(p[0]), tuple(p[1]), c, -1)

    def line(p0, p1, c, w=2):
        a, b = _to_px([p0, p1])
        cv2.line(img, tuple(a), tuple(b), c, w)

    yellow, white = (40, 190, 220), (235, 235, 235)
    if kind == "intersection":
        for sgn in (-1, 1):
            line((0, sgn * CW_OUT), (0, sgn * EXTENT), yellow)
            line((sgn * CW_OUT, 0), (sgn * EXTENT, 0), yellow)
            if bike_lanes:
                for side in (-1, 1):
                    line((side * (BIKE - 1), sgn * CW_OUT), (side * (BIKE - 1), sgn * EXTENT), white, 2)
                    line((sgn * CW_OUT, side * (BIKE - 1)), (sgn * EXTENT, side * (BIKE - 1)), white, 2)
        for ang in range(4):  # zebra crosswalks + stop bars
            R = np.array([[np.cos(ang * np.pi / 2), -np.sin(ang * np.pi / 2)], [np.sin(ang * np.pi / 2), np.cos(ang * np.pi / 2)]])
            for x in np.arange(-ROAD + 0.5, ROAD, 1.0):
                q = np.array([[x, -CW_OUT], [x + 0.5, -CW_OUT], [x + 0.5, -CW_IN], [x, -CW_IN]]) @ R.T
                cv2.fillPoly(img, [_to_px(q)], white)
            sb = np.array([[0, -CW_OUT - 1.2], [ROAD, -CW_OUT - 1.2]]) @ R.T
            line(sb[0], sb[1], white, 4)
    else:
        line((-EXTENT, 0), (EXTENT, 0), yellow)
        for x in np.arange(-1.5, 1.5, 1.0):
            q = np.array([[x, -ROAD], [x + 0.5, -ROAD], [x + 0.5, ROAD], [x, ROAD]])
            cv2.fillPoly(img, [_to_px(q)], white)
    return img


class Camera:
    def __init__(self, P, G2I, I2G, w, h):
        self.P, self.G2I, self.I2G, self.w, self.h = np.asarray(P), np.asarray(G2I), np.asarray(I2G), w, h

    def project(self, X):
        """X: (N, 3) world → (N, 2) pixels, depth (N,)."""
        Xh = np.hstack([X, np.ones((len(X), 1))]) @ self.P.T
        return Xh[:, :2] / Xh[:, 2:3], Xh[:, 2]

    def background(self, tex, night):
        M = self.G2I @ _tex_xform()
        sky = (40, 25, 15) if night else (225, 205, 170)
        img = cv2.warpPerspective(tex, M, (self.w, self.h), flags=cv2.INTER_LINEAR,
                                  borderMode=cv2.BORDER_CONSTANT, borderValue=sky)
        u, v = np.meshgrid(np.arange(self.w), np.arange(self.h))
        wgt = self.I2G[2, 0] * u + self.I2G[2, 1] * v + self.I2G[2, 2]
        img[wgt <= 0] = sky
        if night:
            img = (img * 0.32).astype(np.uint8)
        return img


def _cuboid(x, y, hd, L, W, H):
    c, s = np.cos(hd), np.sin(hd)
    fp = np.array([[L / 2, W / 2], [L / 2, -W / 2], [-L / 2, -W / 2], [-L / 2, W / 2]])
    g = fp @ np.array([[c, s], [-s, c]]) + [x, y]
    bottom = np.column_stack([g, np.zeros(4)])
    top = np.column_stack([g, np.full(4, H)])
    return np.vstack([bottom, top])


def render_camera(cam: Camera, actors, duration, fps, out_path, kind, night=False, bike_lanes=False,
                  label="", noise_px=1.0, seed=0):
    """Writes the mp4 and returns raw detection rows (camera-agnostic fields filled by caller)."""
    rng = np.random.default_rng(seed)
    bg = cam.background(ground_texture(kind, bike_lanes), night)
    ff = shutil.which("ffmpeg")
    proc = subprocess.Popen([ff, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
                             "-s", f"{cam.w}x{cam.h}", "-r", str(fps), "-i", "-", "-c:v", "libx264",
                             "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                             str(out_path)], stdin=subprocess.PIPE)
    rows = []
    n_frames = int(duration * fps)
    for f in range(n_frames):
        t = f / fps
        frame = bg.copy()
        drawn = []
        for a in actors:
            if not a.active(t):
                continue
            x, y, hd = a.pose(t)
            L, W, H = DIMS3[a.cls]
            pts3 = _cuboid(float(x), float(y), float(hd), L, W, H)
            px, depth = cam.project(pts3)
            if (depth < 1.0).any():
                continue
            x1, y1 = px.min(axis=0)
            x2, y2 = px.max(axis=0)
            if x2 < 0 or y2 < 0 or x1 > cam.w or y1 > cam.h:
                continue
            drawn.append((float(depth.mean()), a, px, (x1, y1, x2, y2)))
        drawn.sort(key=lambda d: -d[0])
        for _, a, px, (x1, y1, x2, y2) in drawn:
            col = np.array(a.color, float) * (0.55 if night else 1.0)
            body = cv2.convexHull(px.astype(np.int32))
            cv2.fillConvexPoly(frame, body, tuple(int(c * 0.75) for c in col), lineType=cv2.LINE_AA)
            cv2.fillConvexPoly(frame, px[4:].astype(np.int32), tuple(int(min(255, c * 1.1)) for c in col), lineType=cv2.LINE_AA)
            cv2.polylines(frame, [body], True, (20, 20, 20), 1, cv2.LINE_AA)
            if a.cls == "person":
                head = px[4:].mean(axis=0).astype(int)
                cv2.circle(frame, tuple(head), max(2, int((x2 - x1) * 0.35)), (140, 170, 210), -1, cv2.LINE_AA)
            if night and a.cls in ("car", "truck", "bus"):
                for k in (0, 1):
                    cv2.circle(frame, tuple(px[4 + k].astype(int)), 3, (200, 250, 255), -1, cv2.LINE_AA)
            # detection (what a tracker would output), clipped and jittered
            bx = np.array([x1, y1, x2, y2]) + rng.normal(0, noise_px, 4)
            bx[[0, 2]] = np.clip(bx[[0, 2]], 0, cam.w - 1)
            bx[[1, 3]] = np.clip(bx[[1, 3]], 0, cam.h - 1)
            if bx[3] - bx[1] < 8 or bx[2] - bx[0] < 3 or y2 > cam.h - 1 or x1 < 0 or x2 > cam.w - 1:
                continue  # too small or foot point not in view
            rows.append({"track_id": a.track_id, "cls": a.cls, "frame": f, "t": round(t, 4),
                         "x1": bx[0], "y1": bx[1], "x2": bx[2], "y2": bx[3],
                         "conf": float(rng.uniform(0.55, 0.95) * (0.85 if night else 1.0)),
                         "u": (bx[0] + bx[2]) / 2, "v": bx[3]})
        ts = f"{label}  2026-09-{'14 21' if night else '14 14'}:{int(t // 60):02d}:{t % 60:05.2f}"
        cv2.putText(frame, ts, (16, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(frame, ts, (16, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 1, cv2.LINE_AA)
        proc.stdin.write(frame.tobytes())
    proc.stdin.close()
    proc.wait()
    return rows
