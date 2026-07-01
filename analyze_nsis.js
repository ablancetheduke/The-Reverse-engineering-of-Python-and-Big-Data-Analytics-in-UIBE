const fs = require('fs');
const path = require('path');

const dir = 'C:\\Users\\Ablance\\Desktop';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.exe') && f.includes('惠园'));
const filePath = path.join(dir, files[0]);
console.log('Analyzing:', filePath);

const data = fs.readFileSync(filePath);
console.log('File size:', data.length, 'bytes (' + (data.length / 1024 / 1024).toFixed(1) + ' MB)');

// Find PE signature
const peOffset = data.readUInt32LE(0x3C);
console.log('PE offset:', '0x' + peOffset.toString(16));

// Number of sections
const numSections = data.readUInt16LE(peOffset + 6);
console.log('Number of sections:', numSections);

// Size of optional header
const optHeaderSize = data.readUInt16LE(peOffset + 20);
console.log('Optional header size:', optHeaderSize);

// Section headers
const sectionOffset = peOffset + 24 + optHeaderSize;
let lastEnd = 0;
for (let i = 0; i < numSections; i++) {
  const so = sectionOffset + i * 40;
  const name = data.slice(so, so + 8).toString('latin1').replace(/\x00/g, '');
  const rawSize = data.readUInt32LE(so + 16);
  const rawOffset = data.readUInt32LE(so + 20);
  const end = rawOffset + rawSize;
  console.log('  Section', name, ': offset=' + rawOffset, 'size=' + rawSize, 'end=' + end);
  if (end > lastEnd) lastEnd = end;
}

console.log('Overlay start:', lastEnd, '(0x' + lastEnd.toString(16) + ')');
const overlay = data.slice(lastEnd);
console.log('Overlay size:', overlay.length, '(' + (overlay.length / 1024 / 1024).toFixed(1) + ' MB)');

// First 128 bytes
console.log('\nOverlay first 128 bytes (hex):');
for (let i = 0; i < Math.min(128, overlay.length); i += 16) {
  const chunk = overlay.slice(i, i + 16);
  const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
  const ascii = Array.from(chunk).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
  console.log('  ' + i.toString(16).padStart(6, '0') + ': ' + hex.padEnd(48) + ' ' + ascii);
}

// Check NSIS header
// NSIS firstheader: int32 flags, then header struct
const flags = overlay.readUInt32LE(0);
console.log('\nFirst 4 bytes as uint32 LE:', flags, '(0x' + flags.toString(16) + ')');

// Try reading as NSIS firstheader
// struct firstheader {
//   int flags;
//   int siginfo;  // 4 bytes
//   // followed by NSIS script header
// }
// NSIS solid compression: flags & 0x10 = LZMA, flags & 0x08 = BZIP2, flags & 0x02 = ZLIB

const solidFlags = ['ZLIB', 'BZIP2', 'LZMA'];
console.log('  FH_FLAGS_SILENT:', !!(flags & 1));
console.log('  FH_FLAGS_COMPRESS_ZLIB:', !!(flags & 2));
console.log('  FH_FLAGS_COMPRESS_BZIP2:', !!(flags & 4));
console.log('  FH_FLAGS_COMPRESS_LZMA:', !!(flags & 8));
console.log('  FH_FLAGS_CRC:', !!(flags & 16));

// Look for signature after firstheader
// After firstheader (4 + 4 = 8 bytes), there's the NSIS script header with a magic
// The magic is 0xDEADBEEF or similar
const afterHeader = overlay.readUInt32LE(8);
console.log('\nBytes at offset 8:', '0x' + afterHeader.toString(16));

// Let's look for LZMA stream
// Raw LZMA: properties byte (0x5D) + 4-byte dictSize LE + 8-byte uncompressedSize LE
if (overlay[0] === 0x5D) {
  console.log('\nLooks like raw LZMA at overlay start!');
  const dictSize = overlay.readUInt32LE(1);
  console.log('LZMA dictionary size:', dictSize);
  // uncompressed size bytes 5-12
  const uncompLow = overlay.readUInt32LE(5);
  const uncompHigh = overlay.readUInt32LE(9);
  console.log('Uncompressed size low/high:', uncompLow, uncompHigh);
}

// Search for "NullsoftInst" marker
let idx = overlay.indexOf('NullsoftInst');
console.log('\n"NullsoftInst" at overlay offset:', idx);

// Also search in the whole file
idx = data.indexOf('NullsoftInst');
console.log('"NullsoftInst" at file offset:', idx);
if (idx >= 0) {
  console.log('Context:', data.slice(idx, idx + 128).toString('latin1'));
}

// Search for executable/dll references
console.log('\n--- Searching for common patterns ---');
const appNames = ['electron', 'node', 'python', 'java', 'chromium', 'app-', '惠园', 'huangyuan', 'hy'];
for (const name of appNames) {
  const buf = Buffer.from(name);
  let found = false;
  let pos = 0;
  let count = 0;
  while ((pos = data.indexOf(buf, pos)) !== -1 && count < 5) {
    if (!found) {
      console.log('\nPattern "' + name + '" found at:');
      found = true;
    }
    const ctx = data.slice(Math.max(0, pos - 5), pos + name.length + 30).toString('latin1').replace(/[\x00-\x1f\x7f-\xff]/g, '.');
    console.log('  offset ' + pos + ': ...' + ctx + '...');
    pos += name.length;
    count++;
  }
}
