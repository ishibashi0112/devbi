// The read-only API (/devbi/api/schema, /devbi/api/query) and the morning snapshots (/devbi/snapshots/<file>),
// next to devbi-embed.js in public/devbi/: the dashboards find them there, so data-devbi-api is not needed.
// Files in public/devbi/ are served before this route; it answers the rest of /devbi/.
import { isHostAllowed } from "@devbi/server";
import { devbi } from "@/lib/devbi";

// Host names the browser may use besides IP addresses and localhost (as devbi-serve's --allowed-hosts): another
// site's name pointed at this server (DNS rebinding) cannot read the API.
const allowedHosts = (process.env.DEVBI_ALLOWED_HOSTS ?? "").split(",").filter(Boolean);

async function answer(request: Request): Promise<Response> {
  if (!isHostAllowed(request.headers.get("host") ?? undefined, allowedHosts)) {
    return Response.json({ error: "このホスト名では開けません（DEVBI_ALLOWED_HOSTS に書いてください）" }, { status: 403 });
  }
  // The app's login goes here, as for its other routes (for example: if (!(await auth())) return 401). Files in
  // public/devbi/ (devbi-embed.js, the data files) do not come here: proxy.ts guards them, if they need it.
  return (await devbi.fetch(request)) ?? Response.json({ error: "見つかりません" }, { status: 404 });
}

export { answer as GET, answer as HEAD, answer as POST };
