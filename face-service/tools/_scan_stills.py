"""Which stored frames produce a NAMED result? Picks the best HUD demo still.

Also reports WHICH box YOLO chose, because a false positive at high confidence
looks exactly like a mis-framed box on screen.
"""
import json
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

BASE = "http://127.0.0.1:8090"
ASSETS = Path(r"C:\Users\PureTrek\Desktop\xmrtdao\graytech\deck-assets")
FACES = Path(r"C:\Users\PureTrek\Desktop\Faces\Faces")


def post(image: Path, label: str):
    data = image.read_bytes()
    b = uuid.uuid4().hex
    body = (
        f"--{b}\r\n".encode()
        + f'Content-Disposition: form-data; name="file"; filename="{image.name}"\r\n'.encode()
        + b"Content-Type: image/jpeg\r\n\r\n" + data + f"\r\n--{b}--\r\n".encode()
    )
    url = f"{BASE}/api/live/frame?session=" + urllib.parse.quote(label, safe="")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={b}"})
    return json.loads(urllib.request.urlopen(req, timeout=180).read())


def report(p: Path):
    try:
        d = post(p, p.stem)
    except Exception as e:
        print(f"  {p.name:26} FAIL {type(e).__name__}: {e}")
        return
    i = d.get("identify") or {}
    people = i.get("people") or []
    dets = ", ".join(f"conf={x['conf']:.2f} box={[round(v) for v in x['box']]}"
                     for x in (d.get("persons") or []))
    tags = ", ".join(
        f"{q['stage']}:{q.get('name') or q.get('note') or q.get('reason') or ''}"
        for q in people)
    print(f"  {p.name:26} persons={d.get('count')} named={i.get('named')}")
    if dets:
        print(f"      detect: {dets}")
    if tags:
        print(f"      result: {tags}")


print("=== deck assets (demo stills) ===")
for p in sorted(ASSETS.glob("*.jpg")):
    report(p)

print("\n=== enrolled references (these should name) ===")
for name in ["joe-lee.jpg", "Tom Cruise_1.jpg", "Hugh Jackman_2.jpg",
             "Natalie Portman_3.jpg", "Zac Efron_5.jpg"]:
    p = FACES / name
    if p.exists():
        report(p)
    else:
        print(f"  {name:26} (missing)")