"""Derive the hero globe's textures from public Earth maps.

Run from web/ with Pillow installed:

    python3 scripts/earth_textures.py <sources dir>

The sources dir holds the originals, downloaded once:

- gebco_08_rev_elev_5400x2700.jpg: NASA Blue Marble Next Generation
  topography, 0 to 6400 m, from
  https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/topography-bathymetry-maps/
- Solarsystemscope_texture_8k_earth_clouds.jpg: Solar System Scope clouds,
  CC BY 4.0, from
  https://commons.wikimedia.org/wiki/File:Solarsystemscope_texture_8k_earth_clouds.jpg

The ocean mask is read from public/textures/earth-day.jpg, the Blue Marble
with bathymetry already in the repo: its seas are the only blue-dominant
pixels that are not ice. Every map is written at 4096 px for large screens
and 2048 px for phones, except the mask, whose 2048 px is enough for a
roughness term.
"""

import sys
from pathlib import Path

from PIL import Image, ImageFilter

OUT = Path("public/textures")
DESKTOP = (4096, 2048)
COMPACT = (2048, 1024)


def save(image: Image.Image, name: str, quality: int = 90) -> None:
    image.save(OUT / name, quality=quality, optimize=True, progressive=True)
    print(f"{name}: {image.size[0]}x{image.size[1]}")


def ocean_mask(day: Image.Image) -> Image.Image:
    """White where the Blue Marble shows water, black on land and ice."""

    def water(r: int, g: int, b: int) -> int:
        return 255 if b > g and b - r > 0.25 * b and b > 3 else 0

    out = Image.new("L", day.size)
    out.putdata([water(*pixel) for pixel in day.getdata()])
    # Averaging down to half size antialiases the coast; a light blur hides
    # the JPEG blocks of the source.
    return out.resize(COMPACT, Image.Resampling.BOX).filter(ImageFilter.GaussianBlur(0.6))


def relief(elevation: Image.Image) -> Image.Image:
    """Height for the bump map, lifted so plains read as well as the Andes."""
    return elevation.convert("L").point(lambda v: round(255 * (v / 255) ** 0.6))


def main(sources: Path) -> None:
    day = Image.open(OUT / "earth-day.jpg").convert("RGB")
    save(day.resize(COMPACT, Image.Resampling.LANCZOS), "earth-day-2k.jpg")
    save(ocean_mask(day), "earth-water-2k.jpg", 92)

    height = relief(Image.open(sources / "gebco_08_rev_elev_5400x2700.jpg"))
    save(height.resize(DESKTOP, Image.Resampling.LANCZOS), "earth-relief.jpg")
    save(height.resize(COMPACT, Image.Resampling.LANCZOS), "earth-relief-2k.jpg")

    clouds = Image.open(sources / "Solarsystemscope_texture_8k_earth_clouds.jpg").convert("L")
    save(clouds.resize(DESKTOP, Image.Resampling.LANCZOS), "earth-clouds.jpg", 86)
    save(clouds.resize(COMPACT, Image.Resampling.LANCZOS), "earth-clouds-2k.jpg", 86)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
