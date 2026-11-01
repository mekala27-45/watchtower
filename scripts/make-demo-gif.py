"""Assemble actual browser screenshots as a stage sequence, not elapsed-time video."""
from pathlib import Path
from PIL import Image
import hashlib
import json
import re
import sys

root = Path(__file__).resolve().parent.parent
label = sys.argv[1] if len(sys.argv) > 1 else "local"
if not re.fullmatch(r"[a-z0-9_-]+", label):
    raise ValueError("invalid_report_label")
folder = root / "reports" / "browser"
report = json.loads((folder / f"{label}.json").read_text(encoding="utf-8"))
if report["status"] != "passed":
    raise ValueError("browser_verification_must_pass")
names = [f"{label}-briefing-{stage}.png" for stage in ["review", "approved", "published", "recovered"]]
sources = [Image.open(folder / name).convert("RGB") for name in names]
# Crop only repeated masthead and footer, preserving the actual review and receipt.
crop = (60, 590, sources[0].width - 60)
cropped = [image.crop((crop[0], crop[1], crop[2], image.height - 180)) for image in sources]
height = max(image.height for image in cropped)
frames = []
for image in cropped:
    canvas = Image.new("RGB", (image.width, height), "#F4F6F1")
    canvas.paste(image, (0, 0))
    canvas = canvas.resize((1000, round(height * 1000 / image.width)), Image.Resampling.LANCZOS)
    frames.append(canvas.quantize(colors=256))
target = folder / f"{label}-demo.gif"
durations = [2600, 1800, 2400, 3000]
frames[0].save(target, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=False, disposal=2)
provenance = {
    "schema": "watchtower-screenshot-sequence-v1",
    "artifact": target.name,
    "kind": "presentation_sequence_from_actual_browser_screenshots",
    "not_elapsed_time_video": True,
    "backend": report["backend"],
    "source_revision": report["source_revision"],
    "browser_report": f"reports/browser/{label}.json",
    "capture_started_at": report["started_at"],
    "capture_finished_at": report["finished_at"],
    "processing": "Repeated masthead/footer cropped; frames padded and resized uniformly; no generated interface content.",
    "duration_ms": durations,
    "sources": [{"file": name, "sha256": hashlib.sha256((folder / name).read_bytes()).hexdigest()} for name in names],
    "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
}
(folder / f"{label}-demo.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"artifact": str(target), "frames": len(frames), "bytes": target.stat().st_size}))
