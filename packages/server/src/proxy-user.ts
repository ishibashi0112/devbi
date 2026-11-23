// The signed-in user from a header that a server in front (nginx with oauth2-proxy, …) sets: devbi-serve --user-header.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import type { RequestOptions } from "./handler.js";

export interface ProxyUserOptions {
  /** The header the server in front puts the user name in (`X-DevBI-User`). */
  header: string;
  /**
   * The servers in front whose header is believed, by the address they connect from: IP addresses, or ranges as
   * `10.0.0.0/24`. Default `127.0.0.1` and `::1` (nginx on this computer). IPv4 as IPv4: `::ffff:10.0.0.5` is read as
   * `10.0.0.5`, and an IPv6 range that holds every IPv4 address (`::/8`) is refused.
   */
  trustedProxies?: string[];
  /**
   * When set, only requests whose `X-DevBI-Proxy-Secret` header is this are believed (other programs on that computer).
   * Visible ASCII only (spaces between), so that the server in front sends the same bytes.
   */
  secret?: string;
  /** `CORP\Yamada` and `corp\yamada` as one user: the name in lower case. */
  lowercase?: boolean;
}

/** What the header says of a request: the user (or nobody, with why), or a request refused (two of the header). */
export type ProxyUser = { options: RequestOptions; ignored?: string } | { refuse: string };

export const PROXY_SECRET_HEADER = "x-devbi-proxy-secret";

/** A header's bytes (Node reads them as Latin-1), hashed: compared in the same time whatever their length. */
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest();
// A BOM is kept (not dropped): `﻿alice` is not `alice`.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The address a connection comes from, `::ffff:127.0.0.1` as `127.0.0.1`. */
function remoteOf(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
}

const MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/** A list of trusted addresses as `BlockList` checks them; throws on one that is not an IP address or range. */
export function trustedList(entries: string[]): BlockList {
  const list = new BlockList();
  let count = 0;
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const wrong = () => new Error(`--trusted-proxy の ${entry} は IP アドレス（127.0.0.1）か範囲（10.0.0.0/24）ではありません`);
    const allIPv4 = () => new Error(`--trusted-proxy の ${entry} は、IPv4 のアドレスもすべて含んでしまいます。IPv4 の範囲は 10.0.0.0/8 のように書いてください`);
    let [addr = "", bits, more] = entry.split("/");
    // fe80::1%eth0: BlockList leaves out the zone, so it would trust fe80::1 on every network
    if (addr.includes("%")) throw wrong();
    let prefix = bits === undefined ? undefined : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
    const mapped = MAPPED.exec(addr);
    if (mapped && isIP(mapped[1]!) === 4) {
      // ::ffff:10.0.0.0/104 is 10.0.0.0/8 (and BlockList checks IPv4 addresses as these)
      addr = mapped[1]!;
      if (prefix !== undefined) {
        if (!(prefix <= 128)) throw wrong();
        if (prefix < 96) throw allIPv4();
        prefix -= 96;
      }
    }
    const type = isIP(addr) === 6 ? "ipv6" : isIP(addr) === 4 ? "ipv4" : undefined;
    if (!type || more !== undefined || (prefix !== undefined && !(prefix <= (type === "ipv4" ? 32 : 128)))) throw wrong();
    if (type === "ipv6" && prefix !== undefined && prefix <= 96) {
      // ::/8 holds ::ffff:0:0/96, which BlockList matches every IPv4 address against
      const probe = new BlockList();
      probe.addSubnet(addr, prefix, "ipv6");
      if (probe.check("::ffff:0.0.0.0", "ipv6")) throw allIPv4();
    }
    if (prefix === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, prefix, type);
    count++;
  }
  if (count === 0) throw new Error("--trusted-proxy に IP アドレスがありません（127.0.0.1,::1）");
  return list;
}

/** The secret as the server in front can send it: visible ASCII, spaces only between. */
function checkSecret(secret: string): void {
  if (!secret.trim()) throw new Error("合言葉（proxySecret）が空です");
  if (!/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(secret)) {
    throw new Error(
      "合言葉は、半角の英数字と記号で書いてください（前後の空白、全角の文字、改行は使えません。UTF-16 で保存したファイルなら、UTF-8 で保存し直してください）",
    );
  }
}

/**
 * How devbi-serve reads the signed-in user: the header, believed only from a trusted server in front (by the address
 * it connects from, never `X-Forwarded-For`) with the secret when there is one. Two of the header, or one value with
 * `,` (two joined into one line): refused (a server in front that adds instead of replacing). Empty or only spaces:
 * nobody signed in. Only spaces and tabs around the value are dropped (as HTTP's): `alice　` is not `alice`.
 */
export function proxyUser(options: ProxyUserOptions): (req: IncomingMessage) => ProxyUser {
  const header = options.header.trim().toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(header)) throw new Error(`--user-header の ${options.header} はヘッダーの名前になりません`);
  if (header === PROXY_SECRET_HEADER) throw new Error(`--user-header に ${options.header} は使えません（合言葉のヘッダーです）`);
  const trusted = trustedList(options.trustedProxies ?? ["127.0.0.1", "::1"]);
  if (options.secret !== undefined) checkSecret(options.secret);
  const secret = options.secret === undefined ? undefined : digest(Buffer.from(options.secret, "latin1"));
  const name = options.header.trim();
  const viaFront = "このサーバーは、前に置いたサーバーを通して開きます";
  const believed = (from: string) => {
    try {
      return isIP(from) !== 0 && trusted.check(from, isIP(from) === 6 ? "ipv6" : "ipv4");
    } catch {
      return false;
    }
  };
  return (req) => {
    const values = req.headersDistinct[header];
    const from = remoteOf(req);
    if (!believed(from)) {
      return { options: { signInHint: viaFront }, ...(values?.length ? { ignored: `${from || "（不明）"} は --trusted-proxy にありません` } : {}) };
    }
    if (secret) {
      const given = req.headersDistinct[PROXY_SECRET_HEADER];
      if (given?.length !== 1 || !timingSafeEqual(digest(Buffer.from(given[0]!, "latin1")), secret)) {
        return { options: { signInHint: viaFront }, ...(values?.length ? { ignored: `${from} からの ${PROXY_SECRET_HEADER} が合いません` } : {}) };
      }
    }
    if (!values?.length) return { options: { signInHint: `前のサーバーから ${name} が届いていません` } };
    const added = `前のサーバーは、ブラウザから来た ${name} を上書きします（足しません）`;
    if (values.length > 1) return { refuse: `${name} が ${values.length} つあります。${added}` };
    // Node reads a header's bytes as Latin-1: the server in front sends UTF-8 (a name in Japanese).
    let id: string;
    try {
      id = utf8.decode(Buffer.from(values[0]!, "latin1"));
    } catch {
      return { refuse: `${name} の値が UTF-8 ではありません` };
    }
    id = id.replace(/^[ \t]+|[ \t]+$/g, "");
    if (!id) return { options: { signInHint: `前のサーバーから届いた ${name} が空です` } };
    // Two values joined into one line (`mallory, alice`), as a server in front that adds may send them.
    if (id.includes(",")) return { refuse: `${name} の値に , があります（2 つの値を 1 行にしたもののようです）。${added}` };
    if (options.lowercase) {
      // K (the Kelvin sign) lower-cases to k: another person's name. Names as a person types them only.
      if (id.normalize("NFKC") !== id) {
        return { refuse: `${name} の値に、全角の英字や記号のような、ふつうと違う形の文字があります（--user-lowercase で、ほかの人の名前と同じになることがあるため断ります）` };
      }
      id = id.toLowerCase();
    }
    return { options: { user: { id } } };
  };
}

/**
 * Whether a log line about a header not believed may be written now: once a minute for each address, and at most
 * `perMinute` lines a minute in all (one network has many addresses). `"last"`: the last one this minute.
 */
export function logGate(perMinute = 10, now: () => number = Date.now): (from: string) => boolean | "last" {
  const lastLogged = new Map<string, number>();
  let minute = { start: -Infinity, lines: 0 };
  return (from) => {
    const t = now();
    if (t - minute.start >= 60_000) minute = { start: t, lines: 0 };
    if ((lastLogged.get(from) ?? -Infinity) > t - 60_000) return false;
    if (minute.lines >= perMinute) return false;
    minute.lines++;
    lastLogged.delete(from);
    lastLogged.set(from, t);
    if (lastLogged.size > 1000) lastLogged.delete(lastLogged.keys().next().value!);
    return minute.lines === perMinute ? "last" : true;
  };
}
