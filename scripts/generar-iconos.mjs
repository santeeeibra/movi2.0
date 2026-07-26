// Script de una sola vez para generar los iconos PWA (fondo verde, "M" en
// crema) sin depender de paquetes externos de imagen. Se corre a mano con
// `node scripts/generar-iconos.mjs` si hace falta regenerarlos.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const VERDE = [0x1f, 0x8a, 0x4c];
const CREMA = [0xf7, 0xf6, 0xf2];

// Bitmap 7x9 de la letra "M", 1 = color de letra.
const M = [
  '1000001',
  '1100011',
  '1110111',
  '1011101',
  '1000001',
  '1000001',
  '1000001',
  '1000001',
  '1000001',
];

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function generarPng(size) {
  const rows = M.length;
  const cols = M[0].length;
  // Margen del 20% del icono, la letra ocupa el resto centrada.
  const margen = Math.round(size * 0.22);
  const areaLetra = size - margen * 2;
  const escala = areaLetra / Math.max(rows, cols);
  const anchoLetra = cols * escala;
  const altoLetra = rows * escala;
  const offX = (size - anchoLetra) / 2;
  const offY = (size - altoLetra) / 2;

  const pixels = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 3);
    pixels[rowStart] = 0; // sin filtro
    for (let x = 0; x < size; x++) {
      let color = VERDE;
      const lx = x - offX;
      const ly = y - offY;
      if (lx >= 0 && ly >= 0 && lx < anchoLetra && ly < altoLetra) {
        const col = Math.floor((lx / anchoLetra) * cols);
        const row = Math.floor((ly / altoLetra) * rows);
        if (M[row][col] === '1') color = CREMA;
      }
      const px = rowStart + 1 + x * 3;
      pixels[px] = color[0];
      pixels[px + 1] = color[1];
      pixels[px + 2] = color[2];
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateSync(pixels);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
for (const size of [192, 512, 180]) {
  const nombre = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  writeFileSync(`public/icons/${nombre}`, generarPng(size));
  console.log('Generado public/icons/' + nombre);
}
