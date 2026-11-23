// The signed-in user from a header that a server in front (IIS, nginx with oauth2-proxy) sets: devbi-serve --user-header.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import type { RequestOptions } from "./handler.js";

export interface ProxyUserOptions {
  /** The header the server in front puts the user name in (`X-DevBI-User`). */
  header: string;
  /**
   * The servers in front whose header is believed, by the address they connect from: IP addresses, or ranges as
   * `10.0.0.0/24`. Default `127.0.0.1` and `::1` (IIS or nginx on this computer). `::ffff:127.0.0.1` is `127.0.0.1`.
   */
  trustedProxies?: string[];
  /** When set, only requests whose `X-DevBI-Proxy-Secret` header is this are believed (other programs on that computer). */
  secret?: string;
  /** `CORP\Yamada` and `corp\yamada` as one user: the name in lower case. */
  lowercase?: boolean;
}

/** What the header says of a request: the user (or nobody, with why), or a request refused (two of the header). */
export type ProxyUser = { options: RequestOptions; ignored?: string } | { refuse: string };

export const PROXY_SECRET_HEADER = "x-devbi-proxy-secret";

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The address a connection comes from, `::ffff:127.0.0.1` as `127.0.0.1`. */
function remoteOf(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
}

/** A list of trusted addresses as `BlockList` checks them; throws on one that is not an IP address or range. */
export function trustedList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const [addr = "", bits, more] = entry.split("/");
    const type = isIP(addr) === 6 ? "ipv6" : isIP(addr) === 4 ? "ipv4" : undefined;
    const prefix = bits === undefined ? undefined : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
    if (!type || more !== undefined || (prefix !== undefined && !(prefix <= (type === "ipv4" ? 32 : 128)))) {
      throw new Error(`--trusted-proxy の ${entry} は IP アドレス（127.0.0.1）か範囲（10.0.0.0/24）ではありません`);
    }
    if (prefix === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, prefix, type);
  }
  return list;
}

/**
 * How devbi-serve reads the signed-in user: the header, believed only from a trusted server in front (by the address
 * it connects from, never `X-Forwarded-For`) with the secret when there is one. Two of the header: refused (a server
 * in front that adds instead of replacing). Empty or only spaces: nobody signed in.
 */
export function proxyUser(options: ProxyUserOptions): (req: IncomingMessage) => ProxyUser {
  const header = options.header.trim().toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(header)) throw new Error(`--user-header の ${options.header} はヘッダーの名前になりません`);
  if (header === PROXY_SECRET_HEADER) throw new Error(`--user-header に ${options.header} は使えません（合言葉のヘッダーです）`);
  const trusted = trustedList(options.trustedProxies ?? ["127.0.0.1", "::1"]);
  const secret = options.secret === undefined ? undefined : digest(options.secret);
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
      if (given?.length !== 1 || !timingSafeEqual(digest(given[0]!), secret)) {
        return { options: { signInHint: viaFront }, ...(values?.length ? { ignored: `${from} からの ${PROXY_SECRET_HEADER} が合いません` } : {}) };
      }
    }
    if (!values?.length) return { options: { signInHint: `前のサーバーから ${name} が届いていません` } };
    if (values.length > 1) return { refuse: `${name} が ${values.length} つあります。前のサーバーは、ブラウザから来た ${name} を上書きします（足しません）` };
    // Node reads a header's bytes as Latin-1: the server in front sends UTF-8 (a name in Japanese).
    let id: string;
    try {
      id = utf8.decode(Buffer.from(values[0]!, "latin1"));
    } catch {
      return { refuse: `${name} の値が UTF-8 ではありません` };
    }
    id = id.trim();
    if (!id) return { options: { signInHint: `前のサーバーから届いた ${name} が空です` } };
    if (options.lowercase) id = id.toLowerCase();
    return { options: { user: { id } } };
  };
}
