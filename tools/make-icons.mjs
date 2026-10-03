/**
 * Renders icons/icon{16,32,48,128}.png from tools/icon.svg.
 *
 *   npm install        (once)
 *   npm run icons
 *
 * The PNGs are committed, so this only needs re-running when the artwork
 * changes.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const svg = readFileSync(join(here, 'icon.svg'), 'utf8');
const outDir = join(root, 'icons');
mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)'
  });
  const png = resvg.render().asPng();
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
