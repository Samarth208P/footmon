// One-off script: rasterizes public/footmon.svg into the icon files Next.js
// picks up automatically via its file-based metadata convention
// (app/favicon.ico, app/icon.png, app/apple-icon.png).
// Run with: node scripts/gen-icons.js
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const svgPath = path.join(__dirname, "..", "public", "footmon.svg");
const appDir = path.join(__dirname, "..", "app");

async function renderPng(size) {
  return sharp(svgPath, { density: 384 })
    .resize(size, size)
    .png()
    .toBuffer();
}

// Builds a valid multi-size .ico file using the PNG-in-ICO format
// (supported by all modern browsers/OSes since Windows Vista).
function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * count;
  let offset = headerSize + dirSize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  const imageBuffers = [];

  for (const { size, buffer } of pngBuffers) {
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height (0 = 256)
    entry.writeUInt8(0, 2); // color palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(buffer.length, 8); // image data size
    entry.writeUInt32LE(offset, 12); // image data offset
    offset += buffer.length;
    dirEntries.push(entry);
    imageBuffers.push(buffer);
  }

  return Buffer.concat([header, ...dirEntries, ...imageBuffers]);
}

async function main() {
  const icoSizes = [16, 32, 48];
  const icoPngs = [];
  for (const size of icoSizes) {
    icoPngs.push({ size, buffer: await renderPng(size) });
  }
  const ico = buildIco(icoPngs);
  fs.writeFileSync(path.join(appDir, "favicon.ico"), ico);

  const icon512 = await renderPng(512);
  fs.writeFileSync(path.join(appDir, "icon.png"), icon512);

  const appleIcon = await renderPng(180);
  fs.writeFileSync(path.join(appDir, "apple-icon.png"), appleIcon);

  console.log("Generated: app/favicon.ico, app/icon.png, app/apple-icon.png");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
