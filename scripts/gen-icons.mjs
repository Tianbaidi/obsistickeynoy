// 生成 src-tauri/icons/icon.ico（32x32 32bpp BMP-in-ICO）与 tray.png（32x32 RGBA PNG），无第三方依赖
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "icons");
mkdirSync(outDir, { recursive: true });

const SIZE = 32;
const px = Buffer.alloc(SIZE * SIZE * 4); // BGRA, bottom-up（ico 用）

const yellow = [92, 214, 255, 255]; // BGRA (yellow-ish)
const darker = [60, 160, 230, 255];

function setPixel(x, y, b, g, r, a) {
  const i = (y * SIZE + x) * 4;
  px[i] = b;
  px[i + 1] = g;
  px[i + 2] = r;
  px[i + 3] = a;
}

// 圆角便笺卡片
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const inBody = x >= 3 && x < SIZE - 3 && y >= 3 && y < SIZE - 3;
    if (!inBody) continue;
    const dx = Math.min(x, SIZE - 1 - x);
    const dy = Math.min(y, SIZE - 1 - y);
    if (dx < 8 && dy < 8 && dx * dx + dy * dy > 40) continue; // 圆角
    setPixel(x, y, ...yellow);
  }
}
// 右上角折角
for (let y = 0; y < 9; y++) {
  for (let x = SIZE - 9; x < SIZE; x++) {
    if (x + y > SIZE + 2) setPixel(x, y, ...darker);
  }
}

// ---- ICO（BMP-in-ICO, bottom-up BGRA）----
const headerSize = 6 + 16;
const bihSize = 40;
const xorSize = SIZE * SIZE * 4;
const andSize = Math.ceil(SIZE / 32) * 4 * SIZE;
const buf = Buffer.alloc(headerSize + bihSize + xorSize + andSize);
let o = 0;

buf.writeUInt16LE(0, o); o += 2; // reserved
buf.writeUInt16LE(1, o); o += 2; // type: icon
buf.writeUInt16LE(1, o); o += 2; // count
buf.writeUInt8(SIZE, o); o += 1; // width
buf.writeUInt8(SIZE, o); o += 1; // height
buf.writeUInt8(0, o); o += 1; // colors
buf.writeUInt8(0, o); o += 1; // reserved
buf.writeUInt16LE(1, o); o += 2; // planes
buf.writeUInt16LE(32, o); o += 2; // bitcount
buf.writeUInt32LE(bihSize + xorSize + andSize, o); o += 4; // image size
buf.writeUInt32LE(headerSize, o); o += 4; // image offset

buf.writeUInt32LE(bihSize, o); o += 4;
buf.writeInt32LE(SIZE, o); o += 4; // width
buf.writeInt32LE(SIZE * 2, o); o += 4; // height (XOR + AND)
buf.writeUInt16LE(1, o); o += 2;
buf.writeUInt16LE(32, o); o += 2;
buf.writeUInt32LE(0, o); o += 4; // BI_RGB
buf.writeUInt32LE(xorSize, o); o += 4;
buf.writeInt32LE(0, o); o += 4;
buf.writeInt32LE(0, o); o += 4;
buf.writeUInt32LE(0, o); o += 4;
buf.writeUInt32LE(0, o); o += 4;

for (let y = 0; y < SIZE; y++) {
  const srcRow = (SIZE - 1 - y) * SIZE * 4; // bottom-up
  px.copy(buf, o, srcRow, srcRow + SIZE * 4);
  o += SIZE * 4;
}
buf.fill(0, o, o + andSize); // AND mask

writeFileSync(join(outDir, "icon.ico"), buf);
console.log("icon.ico:", buf.length, "bytes");

// ---- PNG（tray 用，top-down RGBA）----
function crc32(b) {
  let table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < b.length; i++) crc = table[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// BGRA bottom-up → RGBA top-down
const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  const srcRow = (SIZE - 1 - y) * SIZE * 4;
  const dstRow = y * SIZE * 4;
  for (let i = 0; i < SIZE; i++) {
    const si = srcRow + i * 4;
    const di = dstRow + i * 4;
    rgba[di] = px[si + 2]; // R
    rgba[di + 1] = px[si + 1]; // G
    rgba[di + 2] = px[si]; // B
    rgba[di + 3] = px[si + 3]; // A
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(join(outDir, "tray.png"), png);
console.log("tray.png:", png.length, "bytes");
