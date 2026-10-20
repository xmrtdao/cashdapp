"""Can the system actually name Joe Lee from this one photo? Measure it."""
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import face

face.load()
face.reload_identities()
print("gallery size:", len(face.names))

if "Joe_Lee" not in face.names:
    print("Joe_Lee NOT in gallery - cannot be identified")
    raise SystemExit(1)

i = face.names.index("Joe_Lee")
ref = face.matrix[i]
print("Joe_Lee enrolled, L2 norm =", round(float(np.linalg.norm(ref)), 4))

probe = Path(r"C:\Users\PureTrek\Desktop\Faces\Faces\joe-lee.jpg")
img = cv2.imread(str(probe))
print("probe image:", None if img is None else img.shape)

faces, m = face.embed(probe.read_bytes())
print("faces detected:", len(faces))
if not faces:
    raise SystemExit("no face detected")

f = faces[0]
print(f"  face_px={f['face_px']}  iod_px={f['iod_px']}  "
      f"sharpness={f['sharpness']}  band={f['band']}")

cos = float(m[0] @ ref)
print(f"  cosine vs Joe_Lee = {cos:.4f}")

res = face.match(m)[0]
print("  ranked gallery:")
for c in res:
    print(f"    {c['name']:<24} {c['cosine']:.4f}  matched={c['matched']}")

best = res[0]
print()
print("VERDICT:", "IDENTIFIED" if best["matched"] and best["name"] == "Joe_Lee"
      else f"NOT identified (top was {best['name']} @ {best['cosine']})")
print("threshold in force: 0.45")