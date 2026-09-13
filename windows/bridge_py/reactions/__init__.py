"""Reaction overlays — gesture / expression driven emoji & meme layer."""

from .catalog import DEFAULT_MAPPINGS, DEFAULTS, PLACEMENTS, default_config

__all__ = [
    "ReactionEngine",
    "DEFAULTS",
    "DEFAULT_MAPPINGS",
    "PLACEMENTS",
    "default_config",
    "catalog_payload",
]


def __getattr__(name):
    # ReactionEngine pulls in cv2/mediapipe — only the frame processor needs it.
    if name == "ReactionEngine":
        from .engine import ReactionEngine
        return ReactionEngine
    raise AttributeError(name)


def catalog_payload(assets_dir: str | None = None) -> dict:
    """Everything the dashboard settings dialog needs to render itself."""
    from . import animations, common, triggers
    payload = {
        "triggers": triggers.catalog(),
        "animations": animations.catalog(),
        "placements": PLACEMENTS,
        "defaults": [dict(m) for m in DEFAULT_MAPPINGS],
        "images": [],
        "bundledEmoji": [],
        "emojiRenderer": common.renderer_status(),
    }
    if assets_dir:
        payload["images"] = common.list_images(assets_dir)
        payload["bundledEmoji"] = common.bundled_emoji(assets_dir)
    return payload
