// The HTTP side of the API without a database: the same statuses and messages as devbi-serve (docs/reference.md).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Data.SqlClient;
using Xunit;

namespace DevBI.Server.Tests
{
    public class ApiTests
    {
        private static DevBIApi Api(string? dir = null, Func<string, System.Data.Common.DbConnection?>? connect = null, bool exposeErrors = false, List<string>? log = null, bool requireUser = false) =>
            new DevBIApi(new DevBIOptions
            {
                Directory = dir ?? Repo.Sample,
                Connect = connect ?? (_ => null),
                ExposeErrors = exposeErrors,
                Log = log == null ? null : log.Add,
                RequireUser = requireUser,
            });

        /// <summary>A folder with these files (paths with /).</summary>
        private static string Project(Dictionary<string, string> files)
        {
            var dir = Directory.CreateTempSubdirectory("devbi-api-").FullName;
            foreach (var (name, text) in files)
            {
                var path = Path.Combine(dir, name);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, text);
            }
            return dir;
        }

        private static Task<ApiResponse> Schema(DevBIApi api, DevBIUser? user = null, string? hint = null) =>
            api.HandleAsync(new ApiRequest { Action = "schema", Method = "GET", User = user, SignInHint = hint });

        private static string Text(ApiResponse r) => Encoding.UTF8.GetString(r.Body);

        private static Task<ApiResponse> Post(DevBIApi api, string body, string contentType = "application/json") =>
            api.HandleAsync(new ApiRequest { Action = "query", Method = "POST", ContentType = contentType, Body = new MemoryStream(Encoding.UTF8.GetBytes(body)) });

        private static string Error(ApiResponse r)
        {
            Assert.Equal("application/json; charset=utf-8", r.Headers["Content-Type"]);
            Assert.Equal("no-store", r.Headers["Cache-Control"]);
            using var doc = JsonDocument.Parse(r.Body);
            return doc.RootElement.GetProperty("error").GetString()!;
        }

        /// <summary>A connection to a port nobody listens on.</summary>
        private static SqlConnection Nowhere() => new SqlConnection("Server=tcp:127.0.0.1,1;Connect Timeout=1;User Id=x;Password=x;TrustServerCertificate=true");

        [Fact]
        public void FindsTheActionAtTheEndOfThePath()
        {
            Assert.Equal("schema", DevBIApi.ActionOf("/api/schema"));
            Assert.Equal("query", DevBIApi.ActionOf("/Scripts/devbi/api/query"));
            Assert.Null(DevBIApi.ActionOf("/api/query/x"));
            Assert.Null(DevBIApi.ActionOf("/api/other"));
            Assert.Null(DevBIApi.ActionOf("/notapi/query"));
        }

        [Fact]
        public async Task ListsTheSqlFiles()
        {
            var r = await Api().HandleAsync(new ApiRequest { Action = "schema", Method = "GET" });
            Assert.Equal(200, r.Status);
            Assert.Equal("application/json; charset=utf-8", r.Headers["Content-Type"]);
            var text = Encoding.UTF8.GetString(r.Body);
            // Japanese as it is, like JSON.stringify
            Assert.Contains("受注の明細", text);
            using var doc = JsonDocument.Parse(text);
            var all = doc.RootElement.GetProperty("datasets").EnumerateArray().ToList();
            Assert.Equal(new[] { "customer_totals", "customers", "order_lines", "orders", "regions", "sales_daily" }, all.Select(d => d.GetProperty("name").GetString()));
            var orders = all[3];
            Assert.Equal(new[] { "name", "description", "params", "parameters", "connection" }, orders.EnumerateObject().Select(p => p.Name));
            Assert.Equal("[{\"name\":\"from\",\"type\":\"date\",\"label\":\"受注日（から）\"}]", orders.GetProperty("parameters").GetRawText());
            Assert.Equal("DEVBI_DB", orders.GetProperty("connection").GetString());
            Assert.Equal(new[] { "from" }, orders.GetProperty("params").EnumerateArray().Select(p => p.GetString()));
            Assert.Equal(new[] { "受注番号", "行番号" }, all[2].GetProperty("key").EnumerateArray().Select(p => p.GetString()));
            Assert.Equal(new[] { "06:00" }, all[5].GetProperty("snapshot").EnumerateArray().Select(p => p.GetString()));
            Assert.StartsWith("日・地域・商品分類", all[5].GetProperty("description").GetString());
            // devbi-snapshot makes snapshots: none here
            Assert.Equal(0, doc.RootElement.GetProperty("snapshots").GetArrayLength());
        }

        [Fact]
        public async Task ListsAFileItCannotUseWithWhy()
        {
            var dir = Directory.CreateTempSubdirectory("devbi-api-").FullName;
            Directory.CreateDirectory(Path.Combine(dir, "api"));
            File.WriteAllText(Path.Combine(dir, "api", "bad.sql"), "-- connection: erp\nDELETE FROM t");
            File.WriteAllText(Path.Combine(dir, "api", "good.sql"), "-- connection: erp-2\nSELECT 1 AS one");
            File.WriteAllText(Path.Combine(dir, "api", "notes.txt"), "SELECT 1");
            File.WriteAllText(
                Path.Combine(dir, "api", "typed.sql"),
                "-- 地域で絞る\n-- param: regions text[] label=\"地 域\" values=regions default=all\n-- param: from date optional hidden\n-- key: id, \"行\"\nSELECT id FROM t WHERE r IN (:regions) AND (:from IS NULL OR d >= :from) AND x = :x");
            var r = await Api(dir).HandleAsync(new ApiRequest { Action = "schema", Method = "GET" });
            Assert.Equal(
                "{\"datasets\":[{\"name\":\"bad\",\"error\":\"api/bad.sql: SELECT か WITH で始まる文だけ使えます（DELETE で始まっています）\"},{\"name\":\"good\",\"description\":\"\",\"params\":[],\"parameters\":[],\"connection\":\"DEVBI_DB_ERP_2\"},{\"name\":\"typed\",\"description\":\"地域で絞る\",\"params\":[\"regions\",\"from\",\"x\"],\"parameters\":[{\"name\":\"regions\",\"type\":\"text\",\"multiple\":true,\"label\":\"地 域\",\"default\":\"all\",\"values\":\"regions\"},{\"name\":\"from\",\"type\":\"date\",\"optional\":true,\"hidden\":true},{\"name\":\"x\"}],\"key\":[\"id\",\"行\"],\"connection\":\"DEVBI_DB\"}],\"snapshots\":[],\"access\":1}",
                Encoding.UTF8.GetString(r.Body));
            Assert.Equal("{\"datasets\":[],\"snapshots\":[],\"access\":1}", Encoding.UTF8.GetString((await Api(Path.Combine(dir, "none")).HandleAsync(new ApiRequest { Action = "schema", Method = "GET" })).Body));
        }

        [Fact]
        public async Task AnswersWrongRequestsInJapanese()
        {
            var api = Api();
            var r = await api.HandleAsync(new ApiRequest { Action = "query", Method = "GET" });
            Assert.Equal((405, "POST で呼んでください"), (r.Status, Error(r)));
            r = await api.HandleAsync(new ApiRequest { Action = "schema", Method = "POST" });
            Assert.Equal((405, "GET で呼んでください"), (r.Status, Error(r)));
            r = await Post(api, "{\"name\":\"orders\"}", "text/plain");
            Assert.Equal((415, "Content-Type: application/json で送ってください"), (r.Status, Error(r)));
            r = await Post(api, "{\"name\":\"orders\"}", "");
            Assert.Equal(415, r.Status);
            r = await Post(api, "{\"name\":", "Application/JSON; charset=utf-8");
            Assert.Equal((400, "リクエストの JSON を読めません"), (r.Status, Error(r)));
            foreach (var body in new[] { "{}", "null", "[]", "1", "\"orders\"", "{\"name\":1}", "{\"name\":\"\"}", "{\"name\":\"orders\",\"name\":null}" })
            {
                r = await Post(api, body);
                Assert.Equal((400, "name（api/ の SQL ファイルの名前）がありません"), (r.Status, Error(r)));
            }
            foreach (var body in new[] { "{\"name\":\"orders\",\"params\":[]}", "{\"name\":\"orders\",\"params\":null}", "{\"name\":\"orders\",\"params\":\"x\"}" })
            {
                r = await Post(api, body);
                Assert.Equal((400, "params はオブジェクトで送ってください"), (r.Status, Error(r)));
            }
            // not UTF-16 (a lone surrogate): JSON.parse reads it, but no file has such a name
            r = await Post(api, "{\"name\":\"\\ud800\"}");
            Assert.Equal(400, r.Status);
            r = await Post(api, "{\"name\":\"orders\",\"pad\":\"" + new string('x', 256 * 1024) + "\"}");
            Assert.Equal((413, "リクエストが大きすぎます"), (r.Status, Error(r)));
            foreach (var name in new[] { "nothing", "../api/orders", "api/orders", "orders.sql", "ORDERS" })
            {
                r = await Post(api, JsonSerializer.Serialize(new { name }));
                Assert.Equal((404, $"API の SQL {name} はありません（api/{name}.sql）"), (r.Status, Error(r)));
            }
        }

        [Fact]
        public async Task SaysWhereTheConnectionIsMissingOrUnreachable()
        {
            var log = new List<string>();
            var r = await Post(Api(log: log), "{\"name\":\"orders\",\"params\":{\"from\":\"2024-04-01\"}}");
            Assert.Equal((500, "接続先がありません。DEVBI_DB の接続を DevBIOptions.Connect で返してください"), (r.Status, Error(r)));
            Assert.Equal(new[] { "接続先がありません。DEVBI_DB の接続を DevBIOptions.Connect で返してください" }, log);

            log.Clear();
            r = await Post(Api(connect: _ => Nowhere(), log: log), "{\"name\":\"orders\",\"params\":{\"from\":\"2024-04-01\"}}");
            Assert.Equal((500, "データベースにつなげません（くわしくはサーバーのログにあります）"), (r.Status, Error(r)));
            Assert.StartsWith("DEVBI_DB: ", log[0]);

            r = await Post(Api(connect: _ => Nowhere(), exposeErrors: true), "{\"name\":\"orders\",\"params\":{\"from\":\"2024-04-01\"}}");
            Assert.StartsWith("データベースにつなげません: ", Error(r));
        }

        [Fact]
        public async Task InRowLevelModeAnswersNobodySignedInWith401AndAccess1()
        {
            var api = Api(requireUser: true);
            var r = await Schema(api);
            Assert.Equal((401, "{\"error\":\"ログインしていません\",\"access\":1}"), (r.Status, Text(r)));
            r = await Schema(api, new DevBIUser { Id = " \t" }, " このアプリにログインしてください ");
            Assert.Equal((401, "{\"error\":\"ログインしていません（このアプリにログインしてください）\",\"access\":1}"), (r.Status, Text(r)));
            // signed in before anything else is read: the body, its type
            r = await api.HandleAsync(new ApiRequest { Action = "query", Method = "POST", ContentType = "text/plain" });
            Assert.Equal(401, r.Status);
            // and when the host runs a file itself without a user
            var e = await Assert.ThrowsAsync<ApiException>(() => api.RunAsync("orders", null, null));
            Assert.Equal((401, "ログインしていません"), (e.Status, e.Message));
            // the wrong method is still the wrong method
            Assert.Equal(405, (await api.HandleAsync(new ApiRequest { Action = "schema", Method = "POST" })).Status);
        }

        [Fact]
        public async Task InRowLevelModeListsEachFileThatDoesNotSayWhoSeesWhichRowsWithWhy()
        {
            var r = await Schema(Api(requireUser: true), new DevBIUser { Id = " CORP\\yamada " });
            Assert.Equal(200, r.Status);
            using var doc = JsonDocument.Parse(r.Body);
            var orders = doc.RootElement.GetProperty("datasets").EnumerateArray().Single(d => d.GetProperty("name").GetString() == "orders");
            Assert.Equal(
                "api/orders.sql は、だれにどの行を見せるかが書いてありません。:user.… で絞るか、全員に全部の行を見せるなら -- access: all を書いてください（行レベルのモード: ホストの設定 RequireUser）",
                orders.GetProperty("error").GetString());
            Assert.EndsWith(",\"snapshots\":[],\"access\":1,\"user\":{\"id\":\"CORP\\\\yamada\"}}", Text(r));
        }

        [Fact]
        public async Task ListsOnlyTheFilesTheUserMayRead()
        {
            var dir = Project(new Dictionary<string, string>
            {
                ["api/pay.sql"] = "-- 給与\n-- roles: 経理, CORP\\Managers\n-- access: all\nSELECT 1 AS one",
                ["api/mine.sql"] = "SELECT * FROM t WHERE r = :user.region AND d >= :from",
                ["api/bare.sql"] = "-- access: all\nSELECT * FROM t WHERE a = :user",
                ["api/typo.sql"] = "-- role: 経理\nSELECT 1 AS one",
            });
            var log = new List<string>();
            var api = Api(dir, log: log);
            Assert.Equal(401, (await Schema(api)).Status);
            var r = await Schema(api, new DevBIUser { Id = "CORP\\yamada" });
            using (var doc = JsonDocument.Parse(r.Body))
            {
                var all = doc.RootElement.GetProperty("datasets").EnumerateArray().ToList();
                // pay.sql is not even named; the user's values are not parameters the browser sends
                Assert.Equal(new[] { "bare", "mine", "typo" }, all.Select(d => d.GetProperty("name").GetString()));
                Assert.Equal(
                    "api/bare.sql: 行レベルのモードでは :user は使えません。ログインした人の ID なら :user.id と書きます（行レベルのモード: api/bare.sql に -- access: があるため）",
                    all[0].GetProperty("error").GetString());
                Assert.Equal(new[] { "from" }, all[1].GetProperty("params").EnumerateArray().Select(p => p.GetString()));
                Assert.StartsWith("api/typo.sql（1 行目）: -- role: は -- roles: の書き間違いではありませんか", all[2].GetProperty("error").GetString());
            }
            r = await Schema(api, new DevBIUser { Id = "CORP\\boss", IsInRole = role => role == "CORP\\Managers" });
            using (var doc = JsonDocument.Parse(r.Body))
            {
                Assert.Equal(new[] { "bare", "mine", "pay", "typo" }, doc.RootElement.GetProperty("datasets").EnumerateArray().Select(d => d.GetProperty("name").GetString()));
            }
            Assert.Empty(log);
        }

        [Fact]
        public async Task PutsTheProjectInRowLevelModeByTheTextOfItsFiles()
        {
            async Task<int> Status(Dictionary<string, string> files) => (await Schema(Api(Project(files)))).Status;
            Assert.Equal(200, await Status(new Dictionary<string, string> { ["api/a.sql"] = "-- Access log の SQL\nSELECT 1 AS one" }));
            Assert.Equal(200, await Status(new Dictionary<string, string> { ["api/a.sql"] = "SELECT :user_id AS a" }));
            Assert.Equal(401, await Status(new Dictionary<string, string> { ["api/a.sql"] = "SELECT 1 AS a", ["api/b.sql"] = "SELECT 1 AS b -- ｒｏｌｅｓ：" }));
            Assert.Equal(401, await Status(new Dictionary<string, string> { ["api/a.sql"] = "SELECT ':USER.x' AS a" }));
            Assert.Equal(401, await Status(new Dictionary<string, string> { ["api/a.sql"] = "SELECT 1 AS a", ["access/readme.txt"] = "" }));
            // a noncharacter, which .NET's normalization refuses: read as JavaScript reads it, not a 500 for every file
            Assert.Equal(200, await Status(new Dictionary<string, string> { ["api/a.sql"] = "-- 説明\uFFFE\nSELECT 1 AS a -- x\uFFFE" }));
            Assert.Equal(401, await Status(new Dictionary<string, string> { ["api/a.sql"] = "SELECT 1 AS a -- ｒｏｌｅｓ：\uFFFF" }));
        }

        [Fact]
        public async Task SaysOnceWhenItGetsAUserButIsNotInRowLevelMode()
        {
            var log = new List<string>();
            var api = Api(log: log);
            for (var i = 0; i < 2; i++) Assert.Equal(200, (await Schema(api, new DevBIUser { Id = "CORP\\yamada" })).Status);
            Assert.Equal(new[] { "利用者を受け取っていますが、行レベルのモードになっていません（api/*.sql に :user. も -- access: もありません。本番では DevBIOptions.RequireUser を付けます）" }, log);
        }

        [Fact]
        public async Task RefusesAUserOfTheWrongShape()
        {
            var log = new List<string>();
            var api = Api(log: log);
            var r = await Schema(api, new DevBIUser { Id = "u", Attributes = { ["ID"] = "x" } });
            Assert.Equal((500, "DevBIUser.Attributes の ID: id は属性の名前に使えません（:user.id はログインした人の ID です）"), (r.Status, Error(r)));
            r = await Schema(api, new DevBIUser { Id = "u", Attributes = { ["region"] = "a", ["Region"] = "b" } });
            Assert.Equal((500, "DevBIUser.Attributes に Region が 2 つあります（大文字と小文字は区別しません）"), (r.Status, Error(r)));
            r = await Schema(api, new DevBIUser { Id = "u", Attributes = { ["a b"] = "x" } });
            Assert.Equal((500, "DevBIUser.Attributes の a b: 属性の名前は文字・数字・_ で書きます（:user.a b と書けない名前です）"), (r.Status, Error(r)));
            r = await Schema(api, new DevBIUser { Id = "u", Attributes = { ["at"] = DateTime.Now } });
            Assert.Equal((500, "DevBIUser.Attributes の at の値は文字・数値・真偽のどれかにしてください"), (r.Status, Error(r)));
            r = await Schema(api, new DevBIUser { Id = "u", Attributes = { ["n"] = double.NaN } });
            Assert.Equal((500, "DevBIUser.Attributes の n の値が数として読めません（NaN）"), (r.Status, Error(r)));
            // one line each in the log
            Assert.Equal(5, log.Count(l => l.StartsWith("DevBIUser.Attributes", StringComparison.Ordinal)));
        }

        [Fact]
        public void WritesUserIdsOnOneLogLine()
        {
            Assert.Equal("CORP?yamada? x?", Access.LogSafe("CORP\nyamada\u2028 x\u0085"));
        }

        [Fact]
        public void NeedsAFolderAndAConnection()
        {
            Assert.Throws<ArgumentException>(() => new DevBIApi(new DevBIOptions { Connect = _ => null }));
            Assert.Throws<ArgumentException>(() => new DevBIApi(new DevBIOptions { Directory = Repo.Sample }));
            Assert.Throws<ArgumentOutOfRangeException>(() => new DevBIApi(new DevBIOptions { Directory = Repo.Sample, Connect = _ => null, MaxRows = 0 }));
            Assert.Throws<ArgumentOutOfRangeException>(() => new DevBIApi(new DevBIOptions { Directory = Repo.Sample, Connect = _ => null, Timeout = TimeSpan.FromSeconds(-1) }));
            Assert.Throws<ArgumentOutOfRangeException>(() => new DevBIApi(new DevBIOptions { Directory = Repo.Sample, Connect = _ => null, Timeout = TimeSpan.FromDays(30) }));
            Assert.Throws<ArgumentOutOfRangeException>(() => new DevBIApi(new DevBIOptions { Directory = Repo.Sample, Connect = _ => null, UserCache = TimeSpan.FromSeconds(-1) }));
            // the largest of each is fine
            new DevBIApi(new DevBIOptions { Directory = Repo.Sample, Connect = _ => null, MaxRows = int.MaxValue, Timeout = SqlServerQuery.MaxTimeout });
        }

        [Fact]
        public void SaysHowLongItWaitedLikeDevbiServe()
        {
            Assert.Equal("0.5 秒を過ぎたので止めました（x）", SqlServerQuery.TimeoutMessage(TimeSpan.FromMilliseconds(500), "x"));
            Assert.Equal("60 秒を過ぎたので止めました（x）", SqlServerQuery.TimeoutMessage(TimeSpan.FromSeconds(60), "x"));
            Assert.Equal("1.3 秒を過ぎたので止めました（x）", SqlServerQuery.TimeoutMessage(TimeSpan.FromMilliseconds(1250), "x"));
        }
    }
}
