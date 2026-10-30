const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

async function generateIcons(directory = path.resolve(__dirname, '..', 'icons')) {
  const source = await fs.readFile(path.join(directory, 'icon.svg'));
  const outputs = [];
  for (const size of [48, 128]) {
    const image = sharp(source).resize(size, size);
    outputs.push(
      [path.join(directory, `icon-${size}.png`), await image.clone().png().toBuffer()],
      [path.join(directory, `icon-${size}-grayscale.png`),
        await image.clone().grayscale().toColourspace('srgb').png().toBuffer()]
    );
  }
  for (const [file, contents] of outputs) {
    await fs.writeFile(file, contents);
  }
}

if (require.main === module) {
  generateIcons().then(() => {
    console.log('Generated 48px and 128px color and grayscale PNG icons from icons/icon.svg.');
  }).catch((error) => {
    console.error('Icon generation failed:', error);
    process.exitCode = 1;
  });
}

module.exports = { generateIcons };
