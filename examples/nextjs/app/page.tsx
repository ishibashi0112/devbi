import { DevbiDashboard } from "@/components/devbi-dashboard";

// dashboards/sales-db.dash.json of the sales example: read_api('orders', …) each time, through /devbi/api/query.
export default function Page() {
  return (
    <>
      <h1>売上</h1>
      <p>データベースの受注を、この Next.js のアプリの API（app/devbi/[...path]/route.ts）から読みます。</p>
      <DevbiDashboard name="sales-db" />
    </>
  );
}
