/** ascii.mjs — ASCII luminance map of a PNG (visual inspection without eyes) */
import fs from 'fs';
import { PNG } from 'pngjs';

const file = process.argv[2];
const COLS = Number(process.argv[3] ?? 100);
const png = PNG.sync.read(fs.readFileSync(file));
const { width: w, height: h, data: d } = png;
const ROWS = Math.round((COLS * h) / w / 2.1);
const ramp = ' .:-=+*#%@';
let out = '';
for (let ry = 0; ry < ROWS; ry++) {
  let line = '';
  for (let rx = 0; rx < COLS; rx++) {
    let s = 0, n = 0;
    const x0 = Math.floor((rx * w) / COLS), x1 = Math.floor(((rx + 1) * w) / COLS);
    const y0 = Math.floor((ry * h) / ROWS), y1 = Math.floor(((ry + 1) * h) / ROWS);
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * 4;
      s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      n++;
    }
    const v = s / n;
    line += ramp[Math.min(9, Math.floor(v / 26))];
  }
  out += line + '\n';
}
console.log(out);
