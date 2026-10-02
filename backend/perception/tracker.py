"""Multi-object tracker for per-frame detections without ids (VSS YOLO sidecars, YOLO_URL /v1/infer).

ByteTrack-style, dependency-light: constant-velocity box prediction, two association passes (high then low
confidence) by IoU with Hungarian assignment, tentative tracks confirmed after `min_hits` frames.
"""
import numpy as np
from scipy.optimize import linear_sum_assignment

from backend.config import YOLO_CLASSES

KEEP = set(YOLO_CLASSES.values())
# YOLO often flips car/truck/bus on the same object; associate them as one family, report the majority label
FAMILY = {"car": "veh", "truck": "veh", "bus": "veh", "motorcycle": "two", "bicycle": "two", "person": "person"}


def iou(a, b):
    """a: (N,4), b: (M,4) xyxy → (N,M)."""
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)))
    x1 = np.maximum(a[:, None, 0], b[None, :, 0])
    y1 = np.maximum(a[:, None, 1], b[None, :, 1])
    x2 = np.minimum(a[:, None, 2], b[None, :, 2])
    y2 = np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    aa = (a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1])
    bb = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return inter / np.maximum(aa[:, None] + bb[None, :] - inter, 1e-9)


class _Track:
    __slots__ = ("tid", "box", "vel", "fam", "labels", "hits", "miss", "rows", "confirmed")

    def __init__(self, tid, box, fam, label):
        self.tid, self.box, self.vel, self.fam = tid, box.astype(float), np.zeros(4), fam
        self.labels, self.hits, self.miss, self.rows, self.confirmed = {label: 1}, 1, 0, [], False

    def predict(self):
        return self.box + self.vel

    def update(self, box, label):
        self.vel = 0.6 * self.vel + 0.4 * (box - self.box)
        self.box = box.astype(float)
        self.labels[label] = self.labels.get(label, 0) + 1
        self.hits += 1
        self.miss = 0


def nms(dets, thr=0.55):
    """The VSS sidecars carry overlapping duplicate boxes for one object; keep the most confident per family."""
    dets = sorted(dets, key=lambda d: -d[1])
    keep = []
    for lb, c, b in dets:
        if all(FAMILY[lb] != FAMILY[k[0]] or iou(b[None], k[2][None])[0, 0] < thr for k in keep):
            keep.append((lb, c, b))
    return keep


def track(frames, high=0.45, low=0.2, iou_gate=0.2, max_miss=15, min_hits=4):
    """frames: iterable of (frame_idx, t, [(label, conf, [x1,y1,x2,y2]), ...]) in time order.
    Returns rows (track_id, cls, frame, t, x1, y1, x2, y2, conf) for confirmed tracks."""
    active, done, next_id = [], [], 1
    for fidx, t, dets in frames:
        dets = nms([(lb, c, np.asarray(b, float)) for lb, c, b in dets if lb in KEEP and c >= low and len(b) == 4])
        preds = np.array([tr.predict() for tr in active]) if active else np.zeros((0, 4))
        unmatched_tr = list(range(len(active)))
        highs = [d for d in dets if d[1] >= high]
        lows = [d for d in dets if d[1] < high]
        for pass_i, pass_dets in enumerate((highs, lows)):
            used_d = set()
            if pass_dets and unmatched_tr:
                boxes = np.array([d[2] for d in pass_dets])
                sim = iou(preds[unmatched_tr], boxes)
                fam_ok = np.array([[active[i].fam == FAMILY[d[0]] for d in pass_dets] for i in unmatched_tr])
                cost = np.where(fam_ok & (sim >= iou_gate), 1 - sim, 9.0)
                used_t = set()
                for ri, ci in zip(*linear_sum_assignment(cost)):
                    if cost[ri, ci] >= 9.0:
                        continue
                    tr = active[unmatched_tr[ri]]
                    lb, cf, b = pass_dets[ci]
                    tr.update(b, lb)
                    tr.rows.append((fidx, t, b, cf))
                    used_t.add(unmatched_tr[ri]); used_d.add(ci)
                unmatched_tr = [i for i in unmatched_tr if i not in used_t]
            if pass_i == 0:  # only confident leftovers seed new tracks
                for j, (lb, cf, b) in enumerate(pass_dets):
                    if j not in used_d:
                        tr = _Track(next_id, b, FAMILY[lb], lb); next_id += 1
                        tr.rows.append((fidx, t, b, cf)); active.append(tr)
        for i in unmatched_tr:
            active[i].miss += 1
            active[i].box = active[i].predict()
        keep = []
        for tr in active:
            if tr.hits >= min_hits:
                tr.confirmed = True
            if tr.miss > max_miss:
                done.append(tr)
            else:
                keep.append(tr)
        active = keep
    done += active
    out = []
    for tr in done:
        if not tr.confirmed:
            continue
        cls = max(tr.labels, key=tr.labels.get)
        for fidx, t, b, cf in tr.rows:
            out.append((tr.tid, cls, fidx, t, float(b[0]), float(b[1]), float(b[2]), float(b[3]), float(cf)))
    return out
