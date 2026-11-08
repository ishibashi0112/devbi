/**
 * Minimal ZIP reading and writing for xlsx files. No dependencies:
 * deflate goes through the platform's CompressionStream / DecompressionStream
 * (browsers and Node 18+).
 */

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export interface ZipEntry {
  name: string;
  read(): Promise<Uint8Array>;
  text(): Promise<string>;
}

/** List the entries of a ZIP archive. */
export function readZip(buf: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP（xlsx）として読めません: 終端レコードがありません");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("ZIP（xlsx）の目次が壊れています");
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = textDecoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const read = async () => {
      const lnameLen = view.getUint16(localOffset + 26, true);
      const lextraLen = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + lnameLen + lextraLen;
      const data = buf.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return pipe(data, new DecompressionStream("deflate-raw"));
      throw new Error(`対応していない圧縮方式です（${method}）: ${name}`);
    };
    entries.set(name, { name, read, text: async () => textDecoder.decode(await read()) });
  }
  return entries;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of `data`, or of what came before it (`crc` of that) and then `data`. */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Text in parts, one after another (too long for one string: a sheet of 1,000,000 rows). */
export type TextParts = readonly string[];

/** Deflate an entry: its compressed bytes, CRC and size. Text in parts is encoded a batch at a time, never all at once. */
async function deflate(data: Uint8Array | string | TextParts): Promise<{ deflated: Uint8Array; crc: number; size: number }> {
  if (typeof data === "string" || data instanceof Uint8Array) {
    const raw = typeof data === "string" ? textEncoder.encode(data) : data;
    return { deflated: await pipe(raw, new CompressionStream("deflate-raw")), crc: crc32(raw), size: raw.length };
  }
  let crc = 0;
  let size = 0;
  let i = 0;
  const source = new ReadableStream<BufferSource>({
    pull(controller) {
      if (i >= data.length) return controller.close();
      let batch = "";
      while (i < data.length && batch.length < 1 << 20) batch += data[i++];
      const bytes = textEncoder.encode(batch);
      crc = crc32(bytes, crc);
      size += bytes.length;
      controller.enqueue(bytes);
    },
  });
  const deflated = new Uint8Array(await new Response(source.pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  return { deflated, crc, size };
}

/** Build a ZIP archive. Entries are deflated. */
export async function writeZip(files: { name: string; data: Uint8Array | string | TextParts }[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const { deflated, crc, size } = await deflate(f.data);
    const name = textEncoder.encode(f.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 8, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, deflated.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cent = new Uint8Array(46 + name.length);
    const cv = new DataView(cent.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, deflated.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cent.set(name, 46);
    chunks.push(local, deflated);
    central.push(cent);
    offset += local.length + deflated.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
