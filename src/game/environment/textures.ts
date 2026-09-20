/**
 * Procedural texture factory — road asphalt with lane markings & expansion joints,
 * building facade windows, kanji highway signage, radial glow sprites.
 * All textures generated once on canvas and cached.
 */

import * as THREE from 'three';
import { makeCanvas, RNG } from '../core/utils';

function tex(canvas: HTMLCanvasElement, repeatX = 1, repeatY = 1, srgb = true): THREE.Texture {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const cache = new Map<string, THREE.Texture>();
function cached(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = cache.get(key);
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

/**
 * Road deck texture: 4 lanes (3.5m each = 14m) across U, ~14m along V.
 * Includes dashed lane lines, solid edge lines, expansion joint seams, asphalt grain.
 */
export function roadTexture(): THREE.Texture {
  return cached('road', () => {
    const W = 1024;
    const H = 512;
    const { canvas, ctx } = makeCanvas(W, H);
    const rng = new RNG(42);

    // asphalt base
    ctx.fillStyle = '#26282b';
    ctx.fillRect(0, 0, W, H);
    // grain
    for (let i = 0; i < 26000; i++) {
      const g = 28 + rng.next() * 42;
      ctx.fillStyle = `rgba(${g},${g},${g + 2},${0.25 + rng.next() * 0.4})`;
      ctx.fillRect(rng.next() * W, rng.next() * H, 1 + rng.next() * 2, 1 + rng.next() * 2);
    }
    // subtle tire polish tracks (darker wear bands per lane center)
    const laneW = W / 4;
    for (let lane = 0; lane < 4; lane++) {
      const cx = laneW * (lane + 0.5);
      const grad = ctx.createLinearGradient(cx - laneW * 0.32, 0, cx + laneW * 0.32, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(0.35, 'rgba(12,12,14,0.35)');
      grad.addColorStop(0.5, 'rgba(10,10,11,0.42)');
      grad.addColorStop(0.65, 'rgba(12,12,14,0.35)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - laneW * 0.34, 0, laneW * 0.68, H);
    }

    // expansion joints: two dark seams per V repeat (~7m apart at 14m repeat)
    ctx.fillStyle = 'rgba(8,8,9,0.85)';
    ctx.fillRect(0, H * 0.5 - 3, W, 6);
    ctx.fillRect(0, H * 0.5 - 5, W, 2);
    ctx.fillStyle = 'rgba(60,62,66,0.5)';
    ctx.fillRect(0, H * 0.5 + 3, W, 2);
    // stitch marks across joint
    ctx.strokeStyle = 'rgba(140,140,146,0.25)';
    ctx.lineWidth = 2;
    for (let x = 20; x < W; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, H * 0.5 - 6);
      ctx.lineTo(x, H * 0.5 + 6);
      ctx.stroke();
    }

    // edge lines: solid white right, solid yellow-white left (Japan uses white both + median side yellow)
    const edge = (x: number, w: number, color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, 0, w, H);
      // worn effect
      for (let i = 0; i < 300; i++) {
        ctx.fillStyle = 'rgba(38,40,43,0.5)';
        ctx.fillRect(x + rng.next() * w, rng.next() * H, 2, 2 + rng.next() * 4);
      }
    };
    edge(W * 0.028, 9, '#e8e6dd'); // left
    edge(W * 0.965, 9, '#e8e6dd'); // right

    // dashed lane dividers (5m dash / 7m gap => at 14m repeat: 2 dashes)
    const laneXs = [W * 0.27, W * 0.5, W * 0.73];
    ctx.fillStyle = '#dcdcd2';
    for (const lx of laneXs) {
      ctx.fillRect(lx - 5, H * 0.06, 10, H * 0.3);
      ctx.fillRect(lx - 5, H * 0.56, 10, H * 0.3);
    }
    // wear on dashes
    for (const lx of laneXs) {
      for (let i = 0; i < 120; i++) {
        ctx.fillStyle = 'rgba(38,40,43,0.55)';
        ctx.fillRect(lx - 5 + rng.next() * 10, rng.next() * H, 2, 2 + rng.next() * 3);
      }
    }

    return tex(canvas, 1, 1);
  });
}

/** Opposite carriageway (left of median) simple dark asphalt */
export function oncomingRoadTexture(): THREE.Texture {
  return cached('road_onc', () => {
    const { canvas, ctx } = makeCanvas(256, 512);
    const rng = new RNG(7);
    ctx.fillStyle = '#232528';
    ctx.fillRect(0, 0, 256, 512);
    for (let i = 0; i < 5000; i++) {
      const g = 26 + rng.next() * 30;
      ctx.fillStyle = `rgba(${g},${g},${g},0.4)`;
      ctx.fillRect(rng.next() * 256, rng.next() * 512, 2, 2);
    }
    ctx.fillStyle = '#cfcfc6';
    for (let x = 64; x < 256; x += 64) ctx.fillRect(x - 3, 40, 6, 200);
    return tex(canvas, 1, 1);
  });
}

/** Concrete for barriers / pillars — light brushed concrete */
export function concreteTexture(): THREE.Texture {
  return cached('concrete', () => {
    const { canvas, ctx } = makeCanvas(256, 256);
    const rng = new RNG(99);
    ctx.fillStyle = '#8d8d88';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 9000; i++) {
      const g = 120 + rng.next() * 50;
      ctx.fillStyle = `rgba(${g},${g},${g - 4},${0.12 + rng.next() * 0.25})`;
      ctx.fillRect(rng.next() * 256, rng.next() * 256, 1 + rng.next() * 3, 1);
    }
    // horizontal brush streaks
    ctx.strokeStyle = 'rgba(70,70,66,0.08)';
    for (let y = 0; y < 256; y += 3) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(256, y + (rng.next() - 0.5) * 2);
      ctx.stroke();
    }
    return tex(canvas, 3, 1);
  });
}

/** building facade with lit windows (map + emissive in one) */
export function windowTexture(variant: number): THREE.Texture {
  return cached(`windows${variant}`, () => {
    const W = 256;
    const H = 512;
    const { canvas, ctx } = makeCanvas(W, H);
    const rng = new RNG(1000 + variant * 77);
    const bases = ['#12161b', '#171a1f', '#10151b', '#191b20'];
    const base = bases[((variant % bases.length) + bases.length) % bases.length];
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    // Subtle façade modules keep large towers from reading as a single flat
    // tiled block. The windows are intentionally narrower/dimmer than before.
    const cols = 16;
    const rows = 45;
    const cw = W / cols;
    const ch = H / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lit = rng.next() < 0.24;
        const warm = rng.next() < 0.74;
        const b = 0.52 + rng.next() * 0.48;
        if (lit) {
          if (warm) ctx.fillStyle = `rgba(${235 * b | 0},${181 * b | 0},${119 * b | 0},1)`;
          else ctx.fillStyle = `rgba(${126 * b | 0},${195 * b | 0},${224 * b | 0},1)`;
        } else {
          const g = 13 + rng.next() * 14;
          ctx.fillStyle = `rgb(${g},${g + 2},${g + 5})`;
        }
        const mx = cw * 0.19;
        const my = ch * 0.25;
        ctx.fillRect(c * cw + mx, r * ch + my, cw - mx * 2, ch - my * 2);
      }
      // occasional recessed floor band
      if (r % 7 === 6) {
        ctx.fillStyle = 'rgba(4,6,9,0.28)';
        ctx.fillRect(0, r * ch + ch * 0.73, W, ch * 0.16);
      }
    }

    // Vertical service cores / façade breaks.
    for (let c = 3; c < cols; c += 5) {
      ctx.fillStyle = 'rgba(5,7,10,0.34)';
      ctx.fillRect(c * cw, 0, cw * 0.28, H);
    }
    return tex(canvas, 1, 1);
  });
}

/** Japanese green highway sign with kanji + route numbers */
export function signTexture(variant: number): THREE.Texture {
  return cached(`sign${variant}`, () => {
    const W = 512;
    const H = 256;
    const { canvas, ctx } = makeCanvas(W, H);
    const bg = '#0b5e37';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#e9ecec';
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, W - 16, H - 16);
    ctx.fillStyle = '#e9ecec';
    ctx.font = 'bold 44px "Noto Sans JP", "Yu Gothic", "Hiragino Sans", sans-serif';
    ctx.textBaseline = 'middle';
    const texts: [string, string, string][] = [
      ['首都高速 C1', '環状線 · 内回り', '上都橋方向'],
      ['首都高 1号', '羽田線 · 上り', '芝浦 JCT'],
      ['出口 Exit', '9 · 銀座', '500 m'],
    ];
    const t = texts[variant % 3];
    ctx.font = 'bold 52px "Noto Sans JP", "Yu Gothic", "Hiragino Sans", sans-serif';
    ctx.fillText(t[0], 40, 58);
    ctx.font = '38px "Noto Sans JP", "Yu Gothic", "Hiragino Sans", sans-serif';
    ctx.fillText(t[1], 40, 118);
    ctx.font = 'bold 40px "Noto Sans JP", "Yu Gothic", "Hiragino Sans", sans-serif';
    ctx.fillStyle = '#ffe98a';
    ctx.fillText(t[2], 40, 182);
    // route number circle
    ctx.strokeStyle = '#e9ecec';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(W - 66, 66, 38, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#e9ecec';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String([1, 6, 9][variant % 3]), W - 66, 70);
    return tex(canvas, 1, 1);
  });
}

/** radial glow sprite used for taillights / headlights / lamp pools */
export function glowTexture(): THREE.Texture {
  return cached('glow', () => {
    const { canvas, ctx } = makeCanvas(128, 128);
    const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.14)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** soft round particle for spray / embers */
export function softDotTexture(): THREE.Texture {
  return cached('softdot', () => {
    const { canvas, ctx } = makeCanvas(64, 64);
    const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/** rider hoodie back lettering "BFS" */
export function riderBackTexture(): THREE.Texture {
  return cached('riderback', () => {
    const { canvas, ctx } = makeCanvas(256, 256);
    ctx.fillStyle = '#141416';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#d8dbe0';
    ctx.font = 'bold 110px "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BFS', 128, 130);
    // subtle seams
    ctx.strokeStyle = 'rgba(60,60,64,0.8)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(20, 0);
    ctx.lineTo(20, 256);
    ctx.moveTo(236, 0);
    ctx.lineTo(236, 256);
    ctx.stroke();
    return tex(canvas, 1, 1);
  });
}

/** dispose all cached textures (on game teardown) */
export function disposeTextureCache(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
