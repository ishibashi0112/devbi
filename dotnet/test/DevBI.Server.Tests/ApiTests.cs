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
        private static DevBIApi Api(string? dir = null, Func<string, System.Data.Common.DbConnection?>? connect = null, bool exposeErrors = false, List<string>? log = null) =>
            new DevBIApi(new DevBIOptions
            {
                Directory = dir ?? Repo.Sample,
                Connect = connect ?? (_ => null),
                ExposeErrors = exposeErrors,
                Log = log == null ? null : log.Add,
            });

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
            var datasets = doc.RootElement.GetProperty("datasets").EnumerateArray().ToList();
            Assert.Equal(new[] { "orders", "sales_daily" }, datasets.Select(d => d.GetProperty("name").GetString()));
            Assert.Equal(new[] { "name", "description", "params", "connection" }, datasets[0].EnumerateObject().Select(p => p.Name));
            Assert.Equal("DEVBI_DB", datasets[0].GetProperty("connection").GetString());
            Assert.Equal(new[] { "from" }, datasets[0].GetProperty("params").EnumerateArray().Select(p => p.GetString()));
            Assert.Equal(new[] { "06:00" }, datasets[1].GetProperty("snapshot").EnumerateArray().Select(p => p.GetString()));
            Assert.StartsWith("日・地域・商品分類", datasets[1].GetProperty("description").GetString());
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
            var r = await Api(dir).HandleAsync(new ApiRequest { Action = "schema", Method = "GET" });
            Assert.Equal(
                "{\"datasets\":[{\"name\":\"bad\",\"error\":\"api/bad.sql: SELECT か WITH で始まる文だけ使えます（DELETE で始まっています）\"},{\"name\":\"good\",\"description\":\"\",\"params\":[],\"connection\":\"DEVBI_DB_ERP_2\"}],\"snapshots\":[]}",
                Encoding.UTF8.GetString(r.Body));
            Assert.Equal("{\"datasets\":[],\"snapshots\":[]}", Encoding.UTF8.GetString((await Api(Path.Combine(dir, "none")).HandleAsync(new ApiRequest { Action = "schema", Method = "GET" })).Body));
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
            r = await Post(api, "{\"name\":\"orders\",\"pad\":\"" + new string('x', 64 * 1024) + "\"}");
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
        public void NeedsAFolderAndAConnection()
        {
            Assert.Throws<ArgumentException>(() => new DevBIApi(new DevBIOptions { Connect = _ => null }));
            Assert.Throws<ArgumentException>(() => new DevBIApi(new DevBIOptions { Directory = Repo.Sample }));
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
