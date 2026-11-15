import * as THREE from "three";
import { seeded } from "./motion";

/**
 * 4096 px maps on large screens, 2048 px on phones. Five 4K maps hold about
 * 160 MB of GPU memory with their mipmaps, more than a phone gives a tab, and
 * the 8K masters the brief names would need four times that.
 */
export type TextureTier = "4k" | "2k";

export function textureTier(viewportWidth: number, maxTextureSize: number): TextureTier {
  return viewportWidth >= 1024 && maxTextureSize >= 4096 ? "4k" : "2k";
}

export interface EarthMaps {
  day: string;
  night: string;
  relief: string;
  water: string;
  clouds: string;
}

const path = (name: string) => `${import.meta.env.BASE_URL}textures/${name}`;

/** NASA Blue Marble with bathymetry, Black Marble city lights, NASA relief, the ocean mask and the cloud deck. */
export function earthMaps(tier: TextureTier): EarthMaps {
  const big = tier === "4k";
  return {
    day: path(big ? "earth-day.jpg" : "earth-day-2k.jpg"),
    night: path("earth-night.jpg"),
    relief: path(big ? "earth-relief.jpg" : "earth-relief-2k.jpg"),
    water: path("earth-water-2k.jpg"),
    clouds: path(big ? "earth-clouds.jpg" : "earth-clouds-2k.jpg"),
  };
}

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  return [element, element.getContext("2d")!];
}

/** A round, soft dot, reused by every glow sprite. */
export function glowTexture(): THREE.Texture {
  const size = 64;
  const [element, context] = canvas(size, size);
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,0.6)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Photovoltaic cells under glass: deep indigo, each cell a slightly different
 * shade, separated by bright interconnect lines that catch the sun.
 */
export function solarCellTexture(): THREE.Texture {
  const columns = 16;
  const rows = 5;
  const cell = 32;
  const [element, context] = canvas(columns * cell, rows * cell);
  context.fillStyle = "#9aa3b5";
  context.fillRect(0, 0, element.width, element.height);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const shade = seeded(row * columns + column);
      context.fillStyle = `rgb(${10 + shade * 8}, ${16 + shade * 10}, ${52 + shade * 22})`;
      context.fillRect(column * cell + 1.5, row * cell + 1.5, cell - 3, cell - 3);
      // The thin busbars across each cell.
      context.fillStyle = "rgba(170, 180, 200, 0.35)";
      for (const at of [0.33, 0.66]) context.fillRect(column * cell + 2, row * cell + cell * at, cell - 4, 1);
    }
  }
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * Crumpled multi-layer insulation as a normal map: ridged noise gives the
 * sharp creases of foil wrapped by hand, so the gold breaks the sunlight into
 * many small glints.
 */
export function foilNormalTexture(): THREE.Texture {
  const size = 256;
  const height = new Float32Array(size * size);
  const lattice = (x: number, y: number, octave: number) => seeded(((x & 1023) * 1031 + (y & 1023)) * 7 + octave * 131);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value = 0;
      for (let octave = 0, scale = 8, weight = 1; octave < 4; octave++, scale *= 2, weight *= 0.5) {
        const fx = (x / size) * scale;
        const fy = (y / size) * scale;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        const wrap = (v: number) => ((v % scale) + scale) % scale;
        const a = lattice(wrap(ix), wrap(iy), octave);
        const b = lattice(wrap(ix + 1), wrap(iy), octave);
        const c = lattice(wrap(ix), wrap(iy + 1), octave);
        const d = lattice(wrap(ix + 1), wrap(iy + 1), octave);
        const noise = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
        value += weight * (1 - Math.abs(noise * 2 - 1));
      }
      height[y * size + x] = value;
    }
  }
  const [element, context] = canvas(size, size);
  const image = context.createImageData(size, size);
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 6;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 6;
      const length = Math.hypot(dx, dy, 1);
      const offset = (y * size + x) * 4;
      image.data[offset] = (0.5 - dx / length / 2) * 255;
      image.data[offset + 1] = (0.5 - dy / length / 2) * 255;
      image.data[offset + 2] = (0.5 + 1 / length / 2) * 255;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(element);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}
