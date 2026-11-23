// The app's sign-in, as simple as an example can be: pick a person (no password), and the server keeps who in a
// signed cookie. In your app this is its real sign-in (Auth.js, Entra ID, the company's SSO): what DevBI needs is
// only the user each request is from, made on the server (app/devbi-rls/[...path]/route.ts).
// Do not copy this sign-in into an app: its cookie never expires and cannot be revoked (signing out only deletes the
// browser's copy), the secret made at start does not work with several servers, and browsers that send no
// Sec-Fetch-Site are not checked for forms on other sites (app/session/route.ts).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { DevBIUser } from "@devbi/server";

/** The people of this example: in an app, from its sign-in (the id: one that never changes, not the e-mail). */
export const people: Record<string, { name: string; user: DevBIUser }> = {
  yamada: { name: "山田（関東の担当）", user: { id: "CORP\\yamada", roles: ["営業"], attrs: { region: "関東" } } },
  suzuki: { name: "鈴木（近畿の担当）", user: { id: "CORP\\suzuki", roles: ["営業"], attrs: { region: "近畿" } } },
  // Not in access/user.sql (examples/sales/e2e/rls): the region is the app's alone.
  tanaka: { name: "田中（中部の担当）", user: { id: "CORP\\tanaka", roles: ["営業"], attrs: { region: "中部" } } },
  // No region: api/orders.sql answers 403 (whom to show which rows is not known), rather than every row.
  sato: { name: "佐藤（担当の地域なし）", user: { id: "CORP\\sato", roles: ["営業"] } },
};

export const SESSION_COOKIE = "portal_session";

// PORTAL_SESSION_SECRET, or one made when the server starts (everyone signs in again after a restart). globalThis:
// `next dev` loads this file again after each change.
const shared = globalThis as typeof globalThis & { portalSecret?: Buffer };
const secret = () => (shared.portalSecret ??= process.env.PORTAL_SESSION_SECRET ? Buffer.from(process.env.PORTAL_SESSION_SECRET) : randomBytes(32));
const mac = (key: string) => createHmac("sha256", secret()).update(key).digest("base64url");

/** The cookie's value for a person: their key and its signature (the browser cannot make another person's). */
export function sessionValue(key: string): string {
  return `${key}.${mac(key)}`;
}

/** Who this request is from: the person of a cookie the server signed, or undefined. */
export async function signedIn(): Promise<(typeof people)[string] | undefined> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const dot = value.lastIndexOf(".");
  const key = value.slice(0, dot);
  if (dot < 0 || !Object.hasOwn(people, key)) return undefined;
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(mac(key));
  return given.length === expected.length && timingSafeEqual(given, expected) ? people[key] : undefined;
}
