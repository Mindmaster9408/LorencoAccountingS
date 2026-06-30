/**
 * Generates minimal valid PNG icons for PWA install criteria.
 * Uses only Node.js built-ins (zlib) — no external packages needed.
 * Run once: node gen-icons.js
 * Output: icon-192.png, icon-512.png  (solid #667eea with rounded feel)
 */
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

function crc32(buf) {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c;
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
    const len  = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t    = Buffer.from(type, 'ascii');
    const crc  = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
}

function createPNG(size, r, g, b) {
    // IHDR
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(size, 0);
    ihdrData.writeUInt32BE(size, 4);
    ihdrData[8] = 8; // bit depth
    ihdrData[9] = 2; // RGB colour type

    // Raw scanlines — filter byte 0 (None) + RGB pixels
    const row = Buffer.alloc(1 + size * 3);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
        const cx = x - size / 2, cy = 0 - size / 2;
        row[1 + x * 3]     = r;
        row[1 + x * 3 + 1] = g;
        row[1 + x * 3 + 2] = b;
    }
    const raw = Buffer.alloc(size * row.length);
    for (let y = 0; y < size; y++) row.copy(raw, y * row.length);

    const sig  = Buffer.from([137,80,78,71,13,10,26,10]);
    const ihdr = pngChunk('IHDR', ihdrData);
    const idat = pngChunk('IDAT', zlib.deflateSync(raw));
    const iend = pngChunk('IEND', Buffer.alloc(0));
    return Buffer.concat([sig, ihdr, idat, iend]);
}

const R = 0x66, G = 0x7e, B = 0xea; // #667eea — Checkout Charlie brand purple
const dir = path.dirname(__filename);
fs.writeFileSync(path.join(dir, 'icon-192.png'), createPNG(192, R, G, B));
fs.writeFileSync(path.join(dir, 'icon-512.png'), createPNG(512, R, G, B));
console.log('Generated icon-192.png and icon-512.png');
