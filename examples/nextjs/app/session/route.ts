// The sign-in form's POST (app/my/page.tsx): set or clear the session cookie, then a whole new page (303), so that
// no rows of the person before stay in the page.
import { people, SESSION_COOKIE, sessionValue } from "@/lib/session";

export async function POST(request: Request): Promise<Response> {
  // Only this app's own pages may sign someone in or out (a form on another site cannot).
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return Response.json({ error: "このページからはログインできません" }, { status: 403 });
  const form = await request.formData();
  const person = form.get("person");
  let cookie: string;
  if (form.get("action") === "sign-out") {
    cookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  } else if (typeof person === "string" && Object.hasOwn(people, person)) {
    // Secure as well when the app is on https:// (as it should be outside this example).
    cookie = `${SESSION_COOKIE}=${sessionValue(person)}; Path=/; HttpOnly; SameSite=Lax`;
  } else {
    return Response.json({ error: "その人はいません" }, { status: 400 });
  }
  return new Response(null, { status: 303, headers: { Location: "/my", "Set-Cookie": cookie } });
}
