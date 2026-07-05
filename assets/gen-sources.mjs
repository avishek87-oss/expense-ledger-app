// Rasterizes the brand logo into the source PNGs @capacitor/assets expects.
// Run: node assets/gen-sources.mjs  → then: npx @capacitor/assets generate --android
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const dir = dirname(fileURLToPath(import.meta.url));

// The ledger-book mark (cream pages + red/green tags), drawn in a viewBox we scale per output.
const book = (x, y, s) => `
  <g transform="translate(${x},${y}) scale(${s})">
    <rect x="130" y="110" width="252" height="292" rx="12" fill="#f7f4ec"/>
    <rect x="158" y="170" width="196" height="18" rx="4" fill="#1f2a24"/>
    <rect x="158" y="210" width="196" height="18" rx="4" fill="#1f2a24"/>
    <rect x="158" y="250" width="140" height="18" rx="4" fill="#1f2a24"/>
    <rect x="158" y="310" width="80"  height="28" rx="4" fill="#8b3a3a"/>
    <rect x="258" y="310" width="96"  height="28" rx="4" fill="#3f5344"/>
  </g>`;

// Launcher icon: full-bleed dark tile + book (kept within the adaptive safe zone).
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="#1f2a24"/>
  ${book(256, 256, 1)}
</svg>`;

// Splash: brand cream background with a centered rounded logo tile.
const splashTile = (bg) => `<svg xmlns="http://www.w3.org/2000/svg" width="2732" height="2732" viewBox="0 0 2732 2732">
  <rect width="2732" height="2732" fill="${bg}"/>
  <g transform="translate(1110,1110)">
    <rect width="512" height="512" rx="90" fill="#1f2a24"/>
    ${book(0, 0, 1)}
  </g>
</svg>`;

const out = (name) => join(dir, name);
await sharp(Buffer.from(iconSvg)).png().toFile(out('icon.png'));
await sharp(Buffer.from(splashTile('#f1ece0'))).png().toFile(out('splash.png'));
await sharp(Buffer.from(splashTile('#1f2a24'))).png().toFile(out('splash-dark.png'));
console.log('Wrote icon.png, splash.png, splash-dark.png');
