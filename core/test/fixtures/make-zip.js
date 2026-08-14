"use strict";

const zlib = require("zlib");

/**
 * Minimal zip writer for tests: entries = [{ name, data?, mode?, deflate? }].
 * A name ending in "/" is a directory. Mirrors what real archivers emit
 * (store or deflate, unix modes in external attrs) so lib/zip.js is tested
 * against honest input.
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const isDir = e.name.endsWith("/");
    const data = isDir ? Buffer.alloc(0) : Buffer.from(e.data ?? "");
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const method = e.deflate ? 8 : 0;
    const comp = e.deflate ? zlib.deflateRawSync(data) : data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = e.mode ?? (isDir ? 0o755 : 0o644);
    central.writeUInt32LE(((mode | (isDir ? 0o40000 : 0o100000)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + comp.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

module.exports = { makeZip };
