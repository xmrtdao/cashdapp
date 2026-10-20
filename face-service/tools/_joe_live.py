"""Does the live HUD path actually name Joe Lee from a real photo?

Posts the same kind of frame the browser camera sends and checks the three
stages come back in order: found -> checked -> named.
"""
import json
import sys
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cv2

BASE = "http://127.0.0.1:8090"


def post(path: str, image_path: Path):
    data = Path(image_path).read_bytes()
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\n".encode()
        + f'Content-Disposition: form-data; name="file"; filename="{image_path.name}"\r\n'.encode()
        + b"Content-Type: image/jpeg\r\n\r\n"
        + data
        + f"\r\n--{boundary}--\r\n".encode()
    )
    req = urllib.request.Request(
        BASE + path, data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


CASES = [
    (Path(r"C:\Users\PureTrek\Desktop\Faces\Faces\joe-lee.jpg"), "Joe Lee (enrolled)"),
    (Path(__file__).parent.parent / "deck-assets" / "fence-climb.jpg", "stranger in scene"),
    (Path(__file__).parent.parent / "deck-assets" / "hardware.jpg", "no people at all"),
]

for path, label in CASES:
    if not path.exists():
        print(f"  MISSING {path}")
        continue
    print(f"\n=== {label} :: {path.name}")
    # Resize to what the browser sends (960 wide) so this matches production.
    img = cv2.imread(str(path))
    h, w = img.shape[:2]
    if w > 960:
        img = cv2.resize(img, (960, round(960 * h / w)))
    tmp = Path(__file__).parent / "_probe_frame.jpg"
    cv2.imwrite(str(tmp), img)

    d = post(f"/api/live/frame?session=probe-{uuid.uuid4().hex[:8]}", tmp)
    print(f"  find_ms={d.get('find_ms')}  persons={d.get('count')}  "
          f"tracks={d.get('track_count')}")
    ident = d.get("identify") or {}
    print(f"  identify ran={ident.get('ran')}  face_ms={ident.get('face_ms')}  "
          f"gallery={ident.get('gallery')}  named={ident.get('named')}  "
          f"gated={ident.get('gated')}  why={ident.get('why')}")
    for p in ident.get("people", []):
        face = p.get("face") or {}
        print(f"    -> stage={p['stage']:<13} conf={p['conf']} "
              f"face_px={face.get('face_px')} band={face.get('band')} "
              f"name={p.get('name')} cosine={p.get('cosine')}")
        if p.get("reason"):
            print(f"       reason: {p['reason']}")
        if p.get("note"):
            print(f"       note: {p['note']}")

tmp = Path(__file__).parent / "_probe_frame.jpg"
if tmp.exists():
    tmp.unlink()