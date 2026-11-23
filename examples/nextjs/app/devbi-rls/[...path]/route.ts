// The API of 「担当の売上」 (/devbi-rls/api/schema, /devbi-rls/api/query), next to its devbi-embed.js in
// public/devbi-rls/: each request with the user of the app's session, so that api/orders.sql's :user.region is the
// region of who signed in. The browser cannot change it (it is not a parameter of the request).
import { isHostAllowed } from "@devbi/server";
import { devbiRls } from "@/lib/devbi";
import { signedIn } from "@/lib/session";

const allowedHosts = (process.env.DEVBI_ALLOWED_HOSTS ?? "").split(",").filter(Boolean);

async function answer(request: Request): Promise<Response> {
  if (!isHostAllowed(request.headers.get("host") ?? undefined, allowedHosts)) {
    return Response.json({ error: "このホスト名では開けません（DEVBI_ALLOWED_HOSTS に書いてください）" }, { status: 403 });
  }
  // No session: no user (401, with where to sign in). The id, roles and attributes come from the app's sign-in.
  const person = await signedIn();
  const response = await devbiRls.fetch(request, { user: person?.user ?? null, signInHint: "ポータルの「担当の売上（ログイン）」からログインします" });
  return response ?? Response.json({ error: "見つかりません" }, { status: 404 });
}

export { answer as GET, answer as HEAD, answer as POST };
