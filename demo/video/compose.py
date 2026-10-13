#!/usr/bin/env python3
"""Cut the recorded take into a captioned demo video with music.

    python3 demo/video/compose.py demo/video/video.json

record.mjs films the walkthrough as one take and writes marks.json (seconds
where each step starts). Each clip in the manifest is a span of the take
between two marks (plus optional offsets), played at `speed`, framed on a light
page at 1920x1080 with its caption burned in underneath. A white title card and
end card carry the spyglass mark. The music is looped, trimmed and faded under
the whole cut. Needs ffmpeg with drawtext, Pillow, and the Inter font
(SPYGLASS_VIDEO_FONTS, default ~/Library/Fonts).
"""
import json
import os
import subprocess
import sys
from pathlib import Path

from PIL import Image

FONTS = Path(os.path.expanduser(os.environ.get("SPYGLASS_VIDEO_FONTS", "~/Library/Fonts")))
FONT = FONTS / "Inter-Medium.otf"
FONT_BOLD = FONTS / "Inter-SemiBold.otf"
PAGE, CARD, INK, MUTED = "0xF1F3F6", "0xFFFFFF", "0x111827", "0x6B7280"
W, H, FPS = 1920, 1080, 30


def run(*args: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)


def duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(out.stdout.strip())


def esc(text: str) -> str:
    """drawtext treats \\ ' : % as syntax."""
    return text.replace("\\", "\\\\").replace("'", "’").replace(":", "\\:").replace("%", "\\%")


def card(out: Path, seconds: float, mark: Path, line: str, sub: str = "") -> None:
    """The spyglass mark centred on white, a line under it, an optional quieter line."""
    mw, mh = Image.open(mark).size
    h = 170
    w = round(mw * h / mh)
    y = H // 2 - 190
    filters = (
        f"[1:v]scale={w}:{h}:flags=lanczos[m];[0:v][m]overlay=x=(W-w)/2:y={y},"
        f"drawtext=fontfile={FONT}:text='{esc(line)}':fontcolor={INK}:fontsize=52:x=(w-text_w)/2:y={H // 2 + 40}"
    )
    if sub:
        filters += f",drawtext=fontfile={FONT}:text='{esc(sub)}':fontcolor={MUTED}:fontsize=36:x=(w-text_w)/2:y={H // 2 + 125}"
    filters += f",fade=t=in:st=0:d=0.6,fade=t=out:st={seconds - 0.6}:d=0.6[v]"
    run(
        "-f", "lavfi", "-i", f"color=c={CARD}:s={W}x{H}:r={FPS}:d={seconds}", "-i", str(mark),
        "-filter_complex", filters,
        "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(FPS), str(out),
    )


def clip(out: Path, take: Path, start: float, end: float, speed: float, caption: str) -> float:
    """A span of the 1280x800 take, scaled and framed with a soft edge, caption underneath."""
    dur = (end - start) / speed
    run(
        "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", str(take),
        "-f", "lavfi", "-i", f"color=c={PAGE}:s={W}x{H}:r={FPS}",
        "-filter_complex",
        f"[0:v]setpts=(PTS-STARTPTS)/{speed},fps={FPS},scale=1536:960:flags=lanczos,format=yuv420p,"
        f"pad=1540:964:2:2:color=0xD9DDE3[clip];"
        f"[1:v][clip]overlay=x=190:y=30:shortest=1,"
        f"drawtext=fontfile={FONT_BOLD}:text='{esc(caption)}':fontcolor={INK}:fontsize=42:x=(w-text_w)/2:y=1014,"
        f"fade=t=in:st=0:d=0.4,fade=t=out:st={dur - 0.4:.2f}:d=0.4[v]",
        "-map", "[v]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(FPS), str(out),
    )
    return dur


def main() -> None:
    manifest = Path(sys.argv[1]).resolve()
    m = json.loads(manifest.read_text())
    raw = Path(os.path.expanduser(m["raw"]))
    output = Path(os.path.expanduser(m["output"]))
    music = Path(os.path.expanduser(m["music"]["file"]))
    marks = json.loads((raw / "marks.json").read_text())
    take, mark = raw / "take.webm", raw / "mark.png"
    tmp = output.parent / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    for old in tmp.glob("*.mp4"):
        old.unlink()

    parts = [tmp / "00-title.mp4"]
    card(parts[0], 4, mark, m["title"], m.get("subtitle", ""))
    for i, c in enumerate(m["clips"], start=1):
        start = marks[c["from"]] + c.get("from_offset", 0)
        end = marks[c["to"]] + c.get("to_offset", 0)
        out = tmp / f"{i:02d}.mp4"
        dur = clip(out, take, start, end, c.get("speed", 1), c["caption"])
        print(f"  {i:02d} {dur:5.1f}s  {c['caption']}")
        parts.append(out)
    parts.append(tmp / "99-end.mp4")
    card(parts[-1], 4, mark, m["end"], m.get("end_subtitle", ""))

    listing = tmp / "list.txt"
    listing.write_text("".join(f"file '{p}'\n" for p in parts))
    silent = tmp / "silent.mp4"
    run("-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(silent))
    total = duration(silent)
    run(
        "-i", str(silent), "-stream_loop", "-1", "-i", str(music),
        "-filter_complex",
        f"[1:a]atrim=0:{total},afade=t=in:st=0:d=1.5,afade=t=out:st={total - 3:.2f}:d=3,volume=0.85[a]",
        "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-crf", "24", "-preset", "slow",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
        "-shortest", "-movflags", "+faststart", str(output),
    )
    print(f"{output} ({total:.1f}s). Music: {m['music']['credit']}")


if __name__ == "__main__":
    main()
