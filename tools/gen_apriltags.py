#!/usr/bin/env python3
"""Generate AprilTag 25h9 tag PNGs (IDs 0-34) into server/web/apriltags/.

Uses OpenCV's authoritative 25h9 dictionary (same codes/layout as AprilRobotics/apriltag).
Each PNG is the pure 7x7 tag (black border ring included), CELL px per cell.
White print margin is applied via CSS, so the tag itself is edge-to-edge the chosen cm size.
Self-checks every tag with a detect roundtrip.
"""
import os
import cv2

CELL = 256          # px per tag cell -> 1792 px per tag
N = 35              # ids 0..34
OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    '..', 'server', 'web', 'apriltags'))


def get_dict():
    for name in ('DICT_APRILTAG_25h9', 'DICT_APRILTAG_25H9'):
        try:
            return cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, name))
        except (AttributeError, TypeError):
            continue
    raise RuntimeError('no APRILTAG_25h9 dict in cv2.aruco')


def main():
    dic = get_dict()
    os.makedirs(OUT, exist_ok=True)
    for i in range(N):
        marker = cv2.aruco.generateImageMarker(dic, i, CELL * 7)
        cv2.imwrite(os.path.join(OUT, f'tag25h9_{i:02d}.png'), marker)

    # roundtrip self-check: every image must decode back to its own id.
    # Detection needs a white margin around the black border ring, so pad first.
    try:
        det = cv2.aruco.ArucoDetector(dic, cv2.aruco.DetectorParameters())
        for i in range(N):
            img = cv2.imread(os.path.join(OUT, f'tag25h9_{i:02d}.png'))
            img = cv2.copyMakeBorder(img, 30, 30, 30, 30, cv2.BORDER_CONSTANT, value=255)
            ids = det.detectMarkers(img)[1]
            detid = None if ids is None else int(ids.reshape(-1)[0])
            assert detid == i, f'tag {i} decode -> {detid}'
        print(f'roundtrip OK: {N} tags decode to their own id')
    except Exception as e:
        print(f'roundtrip check failed: {e}')

    print(f'generated {N} tags -> {OUT}')


if __name__ == '__main__':
    main()
