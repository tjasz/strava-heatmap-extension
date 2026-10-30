const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

async function generatePromo(directory = path.resolve(__dirname, '..', 'images')) {
  const icon = await fs.readFile(path.resolve(__dirname, '..', 'icons', 'icon.svg'), 'utf8');
  const contours = Array.from({ length: 24 }, (_, i) => {
    const scale = (0.32 + i * 0.22).toFixed(2);
    return `    <use href="#contour" transform="translate(374 104) scale(${scale})" stroke-width="${i % 5 === 0 ? 1.3 : 0.7}"/>`;
  }).join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280" role="img" aria-labelledby="promo-title promo-desc">
  <title id="promo-title">Strava Heatmap for CalTopo</title>
  <desc id="promo-desc">A flaming compass and glowing trails over an original illustrated topographic map.</desc>
  <defs>
    <path id="contour" d="M-8-43C9-49 23-38 28-23C33-9 49-6 47 10C45 26 26 25 17 38C6 52-8 47-18 37C-29 26-44 30-47 15C-51-1-34-11-31-23C-28-36-23-40-8-43Z"/>
    <path id="trail" d="M247 294C249 272 286 272 280 250S260 222 283 211S329 215 322 192S290 171 311 155S355 153 352 131S326 114 344 96S384 90 375 66S390 27 412 12L429-10"/>
    <path id="branch" d="M322 192C347 199 351 181 367 184S391 199 409 183S420 158 451 157"/>
    <linearGradient id="paper">
      <stop stop-color="#fbf7ec"/>
      <stop offset="1" stop-color="#e0e9ce"/>
    </linearGradient>
    <linearGradient id="quiet" x1="0" x2="1">
      <stop offset=".35" stop-color="#fbf7ec"/>
      <stop offset=".78" stop-color="#fbf7ec" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="440" height="280" fill="url(#paper)"/>
  <path d="M270-20C235 47 315 67 268 128S255 240 211 300H460V-20Z" fill="#c6d6b3" opacity=".45"/>
  <g fill="none" stroke="#718568" opacity=".58">
${contours}
  </g>
  <path d="M440 235C400 223 392 246 361 236S333 248 311 265L301 280" fill="none" stroke="#87b6bd" stroke-width="2" opacity=".7"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <g stroke="#d33d74" stroke-width="12" opacity=".12"><use href="#trail"/><use href="#branch"/></g>
    <g stroke="#d84869" stroke-width="5"><use href="#trail"/><use href="#branch"/></g>
    <g stroke="#ff9b43" stroke-width="2.7"><use href="#trail"/><use href="#branch"/></g>
    <g stroke="#fff1b7" stroke-width="1"><use href="#trail"/><use href="#branch"/></g>
  </g>
  <rect width="440" height="280" fill="url(#quiet)"/>
  <g transform="translate(22 16) scale(.94)">
${icon}
  </g>
  <g fill="#202b35" font-family="Arial, Helvetica, sans-serif">
    <text x="28" y="175" font-size="28" font-weight="700" letter-spacing="-.8">Strava Heatmap</text>
    <text x="29" y="204" font-size="23">for CalTopo</text>
    <rect x="29" y="226" width="28" height="3" rx="1.5" fill="#ed6425"/>
    <text x="29" y="251" font-size="10" font-weight="700" letter-spacing="1.6">FIND YOUR NEXT ROUTE</text>
  </g>
</svg>
`;
  const png = await sharp(Buffer.from(svg)).removeAlpha().toColourspace('srgb')
    .png({ palette: false }).toBuffer();
  await fs.writeFile(path.join(directory, 'promo-small.svg'), svg);
  await fs.writeFile(path.join(directory, 'promo-small.png'), png);
}

if (require.main === module) {
  generatePromo().then(() => {
    console.log('Generated images/promo-small.svg and 440x280 RGB images/promo-small.png.');
  }).catch((error) => {
    console.error('Promotional tile generation failed:', error);
    process.exitCode = 1;
  });
}

module.exports = { generatePromo };
