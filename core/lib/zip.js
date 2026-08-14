"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/*
 * Minimal zip extraction — enough for llama.cpp release archives (store +
 * deflate entries, < 4 GB), keeping Core dependency-free. Preserves unix
 * mode bits (llama-server must stay executable) and refuses traversal.
 * No zip64, no encryption — both fail loudly, never silently.
 */

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function extractZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);

  // End of central directory: scan backwards (comment can pad the tail).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`Not a zip file: ${zipPath}`);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || count === 0xffff) throw new Error("zip64 archives are not supported");

  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  const files = [];

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== CDIR_SIG) throw new Error("Corrupt zip: bad central directory");
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const externalAttrs = buf.readUInt32LE(off + 38);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x0001) throw new Error(`Encrypted zip entries are not supported (${name})`);

    // Zip-slip guard: entry must resolve inside destDir.
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`Refusing zip entry escaping the target directory: ${name}`);
    }
    if (name.endsWith("/")) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    // Local header repeats name/extra with possibly different lengths.
    if (buf.readUInt32LE(localOff) !== LOCAL_SIG) throw new Error("Corrupt zip: bad local header");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported zip compression method ${method} (${name})`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    // Unix mode lives in the high 16 bits of external attributes.
    const mode = (externalAttrs >>> 16) & 0o7777;
    if (mode && process.platform !== "win32") fs.chmodSync(target, mode);
    files.push(name);
  }
  return files;
}

module.exports = { extractZip };
