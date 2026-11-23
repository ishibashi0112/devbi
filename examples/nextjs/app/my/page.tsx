import { DevbiDashboard } from "@/components/devbi-dashboard";
import { people, signedIn } from "@/lib/session";

// The row-level security example's dashboard (examples/sales/e2e/rls): its api/orders.sql filters by the region of
// who signed in, so each person sees only their own region's orders; region_totals (-- access: all) shows all.
export default async function Page() {
  const person = await signedIn();
  if (!person) {
    return (
      <>
        <h1>担当の売上</h1>
        <p>ログインした人の担当の地域の受注だけを、この Next.js のアプリの API（app/devbi-rls/[...path]/route.ts）から読みます。見本なので、パスワードはなく、人を選ぶだけです。</p>
        {/* A plain form (not a client-side navigation): the page loads anew as the person. */}
        <form method="post" action="/session" className="sign-in">
          {Object.entries(people).map(([key, p]) => (
            <button key={key} type="submit" name="person" value={key}>
              {p.name}としてログイン
            </button>
          ))}
        </form>
      </>
    );
  }
  return (
    <>
      <h1>担当の売上</h1>
      <form method="post" action="/session" className="sign-in">
        <span data-testid="signed-in">
          {person.name}（{person.user.id}）でログインしています
        </span>
        <button type="submit" name="action" value="sign-out">
          ログアウト
        </button>
      </form>
      {/* api: the project's api/ is not next to the script (its build puts it under e2e/rls/, the folder in Vite's root) */}
      <DevbiDashboard name="my-sales" script="/devbi-rls/devbi-embed.js" api="/devbi-rls/api/" />
    </>
  );
}
