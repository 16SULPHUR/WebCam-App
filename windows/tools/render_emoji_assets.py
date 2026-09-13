"""
render_emoji_assets.py — Bake emoji glyphs into transparent PNG sprites.

The reaction engine renders unknown emoji on the fly, but pre-baking keeps the
bundled pack working on machines without Pillow.

    python tools/render_emoji_assets.py              # rebuild the bundled pack
    python tools/render_emoji_assets.py 🦄 🫠        # add your own

Output: windows/reactions/assets/emoji/<codepoints>.png
Requires: pip install pillow
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = (
    r"C:\Windows\Fonts\seguiemj.ttf",
    r"F:\tools\fonts\seguiemj.ttf",
    r"F:\tools\fonts\NotoColorEmoji.ttf",
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    "/System/Library/Fonts/Apple Color Emoji.ttc",
)

BUNDLED = [
    "👍", "👎", "✌", "👋", "✊", "👌", "🤘", "🤙", "☝", "❤",
    "🎉", "😄", "😮", "😉", "🤨", "🔥", "💯", "😂", "🤯", "👏",
    "🙌", "⭐", "💀", "🥳", "🤔", "✨", "🙏", "🤝", "😎", "😭",
    "🤡", "🫶", "👀", "💩", "🚀", "🍿", "🎯", "🧠", "⚡", "🏆",
]

SIZE = 192


def emoji_filename(char: str) -> str:
    parts = [f"u{ord(c):x}" for c in char if c not in ("\ufe0f", "\ufe0e", "\u200d")]
    return ("_".join(parts) or "unknown") + ".png"


def load_font(px: int):
    path = next((p for p in FONT_CANDIDATES if os.path.isfile(p)), None)
    if not path:
        sys.exit("No colour emoji font found. Install one or edit FONT_CANDIDATES.")
    for size in (px, 109, 96, 64):
        try:
            return ImageFont.truetype(path, size), path
        except OSError:
            continue
    sys.exit(f"Could not open {path} at any supported size.")


def render(char: str, font, px: int) -> Image.Image | None:
    canvas = px * 3
    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((canvas // 2, canvas // 2), char, font=font,
                             embedded_color=True, anchor="mm")
    bbox = img.getbbox()
    if not bbox:
        return None
    img = img.crop(bbox)
    scale = px / float(max(img.size))
    return img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))),
                      Image.LANCZOS)


def main() -> None:
    chars = sys.argv[1:] or BUNDLED
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "reactions", "assets", "emoji")
    os.makedirs(out_dir, exist_ok=True)
    font, font_path = load_font(SIZE)
    print(f"Font: {font_path}\nOutput: {out_dir}\n")

    written = 0
    for char in chars:
        img = render(char, font, SIZE)
        if img is None:
            print(f"  skip  {char}  (font has no glyph)")
            continue
        path = os.path.join(out_dir, emoji_filename(char))
        img.save(path)
        written += 1
        print(f"  ok    {char}  →  {os.path.basename(path)}  {img.width}x{img.height}")
    print(f"\n{written}/{len(chars)} sprites written.")


if __name__ == "__main__":
    main()
