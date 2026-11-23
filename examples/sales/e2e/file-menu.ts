import type { Locator, Page } from "@playwright/test";
import { inflateRawSync } from "node:zlib";

/**
 * Choose an item of the ファイル出力 menu (`Excel（.xlsx）`, `印刷・PDF`, a tile's name for its CSV, `すべてのタイル（.zip）`)
 * in `scope` (the page, or an embedded dashboard).
 */
export async function chooseExport(scope: Page | Locator, item: string): Promise<void> {
  await scope.getByRole("button", { name: "ファイル出力" }).click();
  await scope.getByRole("menu", { name: "ファイル出力" }).getByRole("menuitem", { name: item, exact: true }).click();
}

/** The files of a ZIP (what ファイル出力 → CSV → すべてのタイル saves): name → text. */
export function unzipText(zip: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = zip.readUInt32LE(end + 16);
  for (let n = zip.readUInt16LE(end + 10); n > 0; n--) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const skip = nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    files.set(name, (method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    p += 46 + skip;
  }
  return files;
}
