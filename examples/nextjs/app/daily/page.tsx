import { DevbiDashboard } from "@/components/devbi-dashboard";

// dashboards/sales-daily.dash.json: api/sales_daily.sql has "-- snapshot: 06:00", so the browser reads the file
// the server made this morning (/devbi/snapshots/…), not the database.
export default function Page() {
  return (
    <>
      <h1>日次集計</h1>
      <p>毎朝 6:00 にサーバーが作ったファイルを読みます。</p>
      <DevbiDashboard name="sales-daily" />
    </>
  );
}
