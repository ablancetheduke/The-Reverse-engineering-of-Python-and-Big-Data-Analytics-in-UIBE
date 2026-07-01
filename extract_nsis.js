const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const dir = 'C:\\Users\\Ablance\\Desktop';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.exe') && f.includes('惠园'));
const filePath = path.join(dir, files[0]);
console.log('File:', filePath);

const data = fs.readFileSync(filePath);

// PE overlay
const peOffset = data.readUInt32LE(0x3C);
const numSections = data.readUInt16LE(peOffset + 6);
const optHeaderSize = data.readUInt16LE(peOffset + 20);
const sectionOffset = peOffset + 24 + optHeaderSize;
let lastEnd = 0;
for (let i = 0; i < numSections; i++) {
  const so = sectionOffset + i * 40;
  const rawSize = data.readUInt32LE(so + 16);
  const rawOffset = data.readUInt32LE(so + 20);
  const end = rawOffset + rawSize;
  if (end > lastEnd) lastEnd = end;
}

const overlay = data.slice(lastEnd);

// Parse firstheader
const flags = overlay.readUInt32LE(0);
const siginfo = overlay.readUInt32LE(4);
console.log('Flags:', '0x' + flags.toString(16), 'SigInfo:', '0x' + siginfo.toString(16));

// After firstheader (8 bytes), we have header blocks
// The header starts with magic + header_size
let pos = 8; // Skip firstheader

// Read the header magic and structure
// NSIS header: "NullsoftInst" magic, then header struct
const magic = overlay.slice(pos, pos + 12).toString('latin1');
console.log('Header magic:', magic);
pos += 12; // skip "NullsoftInst"

// header struct (from NSIS source, exehead\fileform.h)
// struct header {
//   int flags;           // 4 bytes
//   int header_size;     // 4 bytes (includes magic size)
//   int arch;            // 4 bytes (0=32bit, 1=64bit) - only in NSIS 3+
//   // then:
//   // int compressed_solid_size; // if solid compression
//   // ... more fields
// }
const headerFlags = overlay.readUInt32LE(pos);
pos += 4;
const headerSize = overlay.readUInt32LE(pos);
pos += 4;
console.log('Header flags:', '0x' + headerFlags.toString(16));
console.log('Header size:', headerSize);

// Check if there's an arch field (NSIS 3+)
// If header_size is reasonable and we have enough data
const arch = overlay.readUInt32LE(pos);
pos += 4;
console.log('Arch:', arch);

// Now parse based on compression type
// flags & 2 = ZLIB, & 4 = BZIP2, & 8 = LZMA
const isSolid = headerFlags & 16;
console.log('Solid compression:', !!isSolid);

// Read the compressed block sizes
// After arch field:
// int32 compressed_size (if solid)
// int32 uncompressed_size
const compressedSize = overlay.readUInt32LE(pos);
pos += 4;
console.log('Compressed size:', compressedSize, '(' + (compressedSize / 1024 / 1024).toFixed(1) + ' MB)');
console.log('Position after sizes:', pos);

// For solid compression, the actual compressed data follows
const compressedData = overlay.slice(pos, pos + compressedSize);
console.log('Compressed data slice:', compressedData.length, 'bytes');
console.log('First bytes of compressed data:', compressedData.slice(0, 32).toString('hex'));

// Check if it's BZIP2 (starts with "BZh")
if (compressedData[0] === 0x42 && compressedData[1] === 0x5A) {
  console.log('\nThis is BZIP2 compressed data!');

  // Try to decompress with bunzip2
  try {
    const decompressed = zlib.brotliDecompressSync(compressedData); // No, use bunzip2
  } catch (e) {}

  // Node.js doesn't have built-in bzip2. Let's save it and try another approach.
  const outPath = path.join(dir, 'nsis_compressed.bz2');
  fs.writeFileSync(outPath, compressedData);
  console.log('Saved compressed data to:', outPath);
  console.log('Size:', compressedData.length);
}

// Let's also look at the rest of the data
const remaining = overlay.slice(pos + compressedSize);
console.log('\nRemaining after compressed block:', remaining.length, 'bytes');
if (remaining.length > 0) {
  console.log('First bytes of remaining:', remaining.slice(0, 64).toString('hex'));
}

// Try to find BZh marker in the overlay
let searchPos = pos;
let bzhIdx;
while ((bzhIdx = overlay.indexOf(Buffer.from('BZh'), searchPos)) !== -1) {
  console.log('\nFound BZh at overlay offset', bzhIdx, 'file offset', lastEnd + bzhIdx);
  console.log('Context:', overlay.slice(bzhIdx, bzhIdx + 20).toString('hex'));
  searchPos = bzhIdx + 1;
}

// Also look for what the uncompressed data size might be
// For BZIP2, the block header contains the original size in the block header
// BZh + digit + 1.. then block header

// Let's just try to use bunzip2 via external command
console.log('\n--- Attempting to find extracted structure ---');
// Look for patterns in the raw data that might indicate the actual app
const patterns = [
  {name: 'PE executable', sig: Buffer.from([0x4D, 0x5A, 0x90, 0x00])}, // MZ
  {name: 'ZIP archive', sig: Buffer.from([0x50, 0x4B, 0x03, 0x04])},    // PK
  {name: '7z archive', sig: Buffer.from([0x37, 0x7A, 0xBC, 0xAF])},    // 7z
  {name: 'RAR archive', sig: Buffer.from([0x52, 0x61, 0x72, 0x21])},    // Rar!
  {name: 'GZIP', sig: Buffer.from([0x1F, 0x8B])},                      // gzip
];
for (const p of patterns) {
  let idx = overlay.indexOf(p.sig);
  if (idx >= 0) {
    console.log(p.name + ' found at overlay offset', idx);
  }
}
