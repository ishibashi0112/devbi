// Against a real SQL Server when DEVBI_TEST_MSSQL is set (CI's service container), the same cases as
// packages/server/test/databases.test.ts:
//   DEVBI_TEST_MSSQL=mssql://sa:<password>@127.0.0.1:1433/master   (or an ADO.NET connection string)
// The tests create and drop tables there (orders, order_lines, customers, products, devbi_types): use a database kept
// for tests.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Apache.Arrow;
using Apache.Arrow.Ipc;
using Apache.Arrow.Types;
using Microsoft.Data.SqlClient;
using Microsoft.Data.Sqlite;
using Xunit;

namespace DevBI.Server.Tests
{
    /// <summary>A test that needs SQL Server: skipped without DEVBI_TEST_MSSQL.</summary>
    public sealed class SqlServerFactAttribute : FactAttribute
    {
        public SqlServerFactAttribute()
        {
            if (SqlServer.ConnectionString == null) Skip = "DEVBI_TEST_MSSQL がありません";
        }
    }

    /// <summary>The test database: devbi_types and the sample's tables, made once.</summary>
    public sealed class SqlServer
    {
        public static readonly string? ConnectionString = ConnectionStringOf(Environment.GetEnvironmentVariable("DEVBI_TEST_MSSQL"));

        /// <summary>mssql://user:password@host:port/database (as the Node tests take it), or an ADO.NET connection string.</summary>
        private static string? ConnectionStringOf(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            if (!value.StartsWith("mssql://", StringComparison.OrdinalIgnoreCase) && !value.StartsWith("sqlserver://", StringComparison.OrdinalIgnoreCase)) return value;
            var url = new Uri(value);
            var user = url.UserInfo.Split(':', 2);
            return new SqlConnectionStringBuilder
            {
                DataSource = $"tcp:{url.Host},{(url.Port > 0 ? url.Port : 1433)}",
                InitialCatalog = Uri.UnescapeDataString(url.AbsolutePath.TrimStart('/')) is { Length: > 0 } db ? db : "master",
                UserID = Uri.UnescapeDataString(user[0]),
                Password = user.Length > 1 ? Uri.UnescapeDataString(user[1]) : "",
                Encrypt = false,
                TrustServerCertificate = true,
            }.ConnectionString;
        }

        public SqlServer()
        {
            Directory = System.IO.Directory.CreateTempSubdirectory("devbi-mssql-").FullName;
            System.IO.Directory.CreateDirectory(Path.Combine(Directory, "api"));
            foreach (var f in new[] { "orders.sql", "sales_daily.sql" }) File.Copy(Path.Combine(Repo.Sample, "api", f), Path.Combine(Directory, "api", f));
            File.WriteAllText(Path.Combine(Directory, "api", "types.sql"), "-- 型の確認\nSELECT * FROM devbi_types WHERE d >= :from AND region <> :skip AND (:from IS NOT NULL) ORDER BY id");
            File.WriteAllText(Path.Combine(Directory, "api", "text.sql"), "SELECT region, 'a:b ? @p1 ;' AS s FROM devbi_types WHERE id = :id");
            File.WriteAllText(Path.Combine(Directory, "api", "kinds.sql"), "SELECT CAST(:s AS NVARCHAR(10)) AS s, :i + 1 AS i, :b AS b, :f * 2 AS f, :big AS big, CAST(:n AS INT) AS n");
            if (ConnectionString == null) return;
            using var conn = new SqlConnection(ConnectionString);
            conn.Open();
            Exec(conn, "DROP TABLE IF EXISTS order_lines; DROP TABLE IF EXISTS orders; DROP TABLE IF EXISTS customers; DROP TABLE IF EXISTS products; DROP TABLE IF EXISTS devbi_types; DROP TABLE IF EXISTS devbi_ddl_probe");
            Exec(conn, @"CREATE TABLE devbi_types (id BIGINT, d DATE, ts DATETIME2(3), amount DECIMAL(12,2), rate FLOAT, region NVARCHAR(20), big BIGINT,
                ok BIT, dto DATETIMEOFFSET, t TIME(0), g UNIQUEIDENTIFIER, bin VARBINARY(4))");
            Exec(conn, @"INSERT INTO devbi_types VALUES
                (1, '2026-04-01', '2026-04-01 09:30:00.250', 1200.50, 0.5, N'関東', 9007199254740993, 1, '2026-04-01 09:30:00 +09:00', '09:30:00', 'C5B1AB40-2D3E-4F4E-9C5B-1B2B3C4D5E6F', 0x01020304),
                (2, '2026-04-02', NULL, 800, NULL, N'近畿', NULL, 0, NULL, NULL, NULL, NULL),
                (3, '2026-03-31', NULL, 1, NULL, N'九州', NULL, NULL, NULL, NULL, NULL, NULL)");
            // The sample's tables (examples/sales/db/sales.sqlite), the way examples/sales/api/*.sql read them.
            using var sqlite = new SqliteConnection($"Data Source={Path.Combine(Repo.Sample, "db", "sales.sqlite")};Mode=ReadOnly");
            sqlite.Open();
            var tables = new[]
            {
                ("customers", "id INTEGER PRIMARY KEY, name NVARCHAR(100) NOT NULL, region NVARCHAR(20) NOT NULL", "SELECT id, name, region FROM customers"),
                ("products", "id INTEGER PRIMARY KEY, category NVARCHAR(50) NOT NULL, name NVARCHAR(100) NOT NULL", "SELECT id, category, name FROM products"),
                ("orders", "order_no VARCHAR(20) PRIMARY KEY, order_date DATE NOT NULL, customer_id INTEGER NOT NULL", "SELECT order_no, order_date, customer_id FROM orders"),
                ("order_lines", "order_no VARCHAR(20) NOT NULL, line_no INTEGER NOT NULL, product_id INTEGER NOT NULL, qty INTEGER NOT NULL, unit_price INTEGER NOT NULL", "SELECT order_no, line_no, product_id, qty, unit_price FROM order_lines"),
            };
            foreach (var (table, ddl, select) in tables)
            {
                Exec(conn, $"CREATE TABLE {table} ({ddl})");
                using var read = sqlite.CreateCommand();
                read.CommandText = select;
                using var rows = read.ExecuteReader();
                var batch = new List<string>();
                while (true)
                {
                    var more = rows.Read();
                    if (more) batch.Add("(" + string.Join(", ", Enumerable.Range(0, rows.FieldCount).Select(i => Literal(rows.GetValue(i)))) + ")");
                    if (batch.Count == 500 || (!more && batch.Count > 0))
                    {
                        Exec(conn, $"INSERT INTO {table} VALUES {string.Join(", ", batch)}");
                        batch.Clear();
                    }
                    if (!more) break;
                }
            }
        }

        public string Directory { get; }

        private static string Literal(object v) =>
            v switch
            {
                DBNull => "NULL",
                long or int or double => Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture)!,
                _ => "N'" + v.ToString()!.Replace("'", "''") + "'",
            };

        public static void Exec(SqlConnection conn, string sql)
        {
            using var command = conn.CreateCommand();
            command.CommandText = sql;
            command.ExecuteNonQuery();
        }

        public DevBIApi Api(int maxRows = 2, string? dir = null, List<string>? log = null) =>
            new DevBIApi(new DevBIOptions
            {
                Directory = dir ?? Directory,
                Connect = name => name == "DEVBI_DB" ? new SqlConnection(ConnectionString) : null,
                ExposeErrors = true,
                MaxRows = maxRows,
                Log = log == null ? null : log.Add,
            });

        public static async Task<ResultSet> Query(string sql, int? maxRows = null, TimeSpan? timeout = null, params object?[] values)
        {
            using var conn = new SqlConnection(ConnectionString);
            await conn.OpenAsync();
            return await SqlServerQuery.RunAsync(conn, sql, values, maxRows, timeout ?? TimeSpan.Zero, "x", CancellationToken.None);
        }
    }

    public class SqlServerTests : IClassFixture<SqlServer>
    {
        private readonly SqlServer db;

        public SqlServerTests(SqlServer db)
        {
            this.db = db;
        }

        private static RecordBatch Read(byte[] bytes)
        {
            using var reader = new ArrowStreamReader(new MemoryStream(bytes));
            var batch = reader.ReadNextRecordBatch();
            Assert.Null(reader.ReadNextRecordBatch());
            return batch;
        }

        private static string TypeText(IArrowType t) =>
            t switch
            {
                Int64Type => "Int64",
                DoubleType => "Float64",
                BooleanType => "Bool",
                Date32Type => "Date32<DAY>",
                TimestampType ts => $"Timestamp<{ts.Unit.ToString().ToUpperInvariant()}>{(ts.Timezone == null ? "" : ts.Timezone)}",
                StringType => "Utf8",
                _ => t.Name,
            };

        private static readonly DateTime Epoch = new DateTime(1970, 1, 1);

        private static long Micros(DateTime d) => (d - Epoch).Ticks / 10;

        [SqlServerFact]
        public async Task ReadsEachTypeAsDevBIs()
        {
            var result = await db.Api().RunAsync("types", new Dictionary<string, object?> { ["from"] = "2026-04-01", ["skip"] = "九州" });
            Assert.Equal(2, result.Rows);
            var t = Read(result.Bytes);
            Assert.Equal(
                new[] { "id:Int64", "d:Date32<DAY>", "ts:Timestamp<MICROSECOND>", "amount:Float64", "rate:Float64", "region:Utf8", "big:Int64", "ok:Bool", "dto:Timestamp<MICROSECOND>", "t:Utf8", "g:Utf8", "bin:Utf8" },
                t.Schema.FieldsList.Select(f => $"{f.Name}:{TypeText(f.DataType)}"));
            Assert.Equal(2, t.Length);
            Assert.Equal(new long?[] { 1, 2 }, ((Int64Array)t.Column("id")).ToArray());
            Assert.Equal((int)(new DateTime(2026, 4, 1) - Epoch).TotalDays, ((Date32Array)t.Column("d")).GetValue(0));
            Assert.Equal(Micros(new DateTime(2026, 4, 1, 9, 30, 0, 250)), ((TimestampArray)t.Column("ts")).GetValue(0));
            Assert.Null(((TimestampArray)t.Column("ts")).GetValue(1));
            Assert.Equal(new double?[] { 1200.5, 800 }, ((DoubleArray)t.Column("amount")).ToArray());
            Assert.Equal(new double?[] { 0.5, null }, ((DoubleArray)t.Column("rate")).ToArray());
            Assert.Equal("関東", ((StringArray)t.Column("region")).GetString(0));
            Assert.Equal(9007199254740993L, ((Int64Array)t.Column("big")).GetValue(0));
            Assert.Equal(new bool?[] { true, false }, Enumerable.Range(0, 2).Select(i => ((BooleanArray)t.Column("ok")).GetValue(i)));
            // DATETIMEOFFSET is a moment: its UTC time
            Assert.Equal(Micros(new DateTime(2026, 4, 1, 0, 30, 0)), ((TimestampArray)t.Column("dto")).GetValue(0));
            Assert.Equal("09:30:00", ((StringArray)t.Column("t")).GetString(0));
            Assert.Equal("C5B1AB40-2D3E-4F4E-9C5B-1B2B3C4D5E6F", ((StringArray)t.Column("g")).GetString(0));
            Assert.Equal("AQIDBA==", ((StringArray)t.Column("bin")).GetString(0));
        }

        [SqlServerFact]
        public async Task SendsParametersAsValuesAndLeavesQuotedTextAlone()
        {
            var t = Read((await db.Api().RunAsync("text", new Dictionary<string, object?> { ["id"] = 2 })).Bytes);
            Assert.Equal(("近畿", "a:b ? @p1 ;"), (((StringArray)t.Column("region")).GetString(0), ((StringArray)t.Column("s")).GetString(0)));
            // the kinds of values JSON has, as Node's mssql package sends them
            t = Read((await db.Api().RunAsync("kinds", new Dictionary<string, object?> { ["s"] = "関東", ["i"] = 41, ["b"] = true, ["f"] = 0.25, ["big"] = 9007199254740991L, ["n"] = null })).Bytes);
            Assert.Equal("関東", ((StringArray)t.Column("s")).GetString(0));
            Assert.Equal(42L, ((Int64Array)t.Column("i")).GetValue(0));
            Assert.True(((BooleanArray)t.Column("b")).GetValue(0));
            Assert.Equal(0.5, ((DoubleArray)t.Column("f")).GetValue(0));
            Assert.Equal(9007199254740991L, ((Int64Array)t.Column("big")).GetValue(0));
            Assert.Null(((Int64Array)t.Column("n")).GetValue(0));
        }

        [SqlServerFact]
        public async Task ReadsTheSamplesOrdersWithTheSameTotalAsTheExcel()
        {
            var api = db.Api(1_000_000, Repo.Sample);
            var lines = Read((await api.RunAsync("orders", new Dictionary<string, object?> { ["from"] = "2024-04-01" })).Bytes);
            Assert.Equal(6044, lines.Length);
            Assert.Equal(193161410L, ((Int64Array)lines.Column("金額")).Values.ToArray().Sum());
            Assert.IsType<Date32Type>(lines.Schema.GetFieldByName("受注日").DataType);
            var daily = Read((await api.RunAsync("sales_daily", new Dictionary<string, object?> { ["from"] = "2024-04-01" })).Bytes);
            Assert.Equal(4014, daily.Length);
            Assert.Equal(193161410L, ((Int64Array)daily.Column("金額")).Values.ToArray().Sum());
        }

        [SqlServerFact]
        public async Task AnswersOverHttpWithArrowGzipAndTheRowCount()
        {
            var log = new List<string>();
            var api = db.Api(1_000_000, Repo.Sample, log);
            var r = await api.HandleAsync(new ApiRequest
            {
                Action = "query",
                Method = "POST",
                ContentType = "application/json",
                AcceptEncoding = "gzip, deflate, br",
                Body = new MemoryStream(Encoding.UTF8.GetBytes("{\"name\":\"orders\",\"params\":{\"from\":\"2024-04-01\"}}")),
            });
            Assert.Equal(200, r.Status);
            Assert.Equal("application/vnd.apache.arrow.stream", r.Headers["Content-Type"]);
            Assert.Equal("no-store", r.Headers["Cache-Control"]);
            Assert.Equal("Accept-Encoding", r.Headers["Vary"]);
            Assert.Equal("6044", r.Headers["X-DevBI-Rows"]);
            Assert.Equal("gzip", r.Headers["Content-Encoding"]);
            using var unzipped = new MemoryStream();
            using (var gzip = new GZipStream(new MemoryStream(r.Body), CompressionMode.Decompress)) gzip.CopyTo(unzipped);
            Assert.Equal(6044, Read(unzipped.ToArray()).Length);
            Assert.Matches("^api/orders.sql: 6,044 行、[0-9]+ ms$", Assert.Single(log));
            // a few rows: not worth zipping
            r = await api.HandleAsync(new ApiRequest
            {
                Action = "query",
                Method = "POST",
                ContentType = "application/json",
                AcceptEncoding = "gzip",
                Body = new MemoryStream(Encoding.UTF8.GetBytes("{\"name\":\"orders\",\"params\":{\"from\":\"2099-01-01\"}}")),
            });
            Assert.False(r.Headers.ContainsKey("Content-Encoding"));
            Assert.Equal(0, Read(r.Body).Length);
            // parameters are checked once connected (as devbi-serve does)
            r = await api.HandleAsync(new ApiRequest { Action = "query", Method = "POST", ContentType = "application/json", Body = new MemoryStream(Encoding.UTF8.GetBytes("{\"name\":\"orders\",\"params\":{}}")) });
            Assert.Equal(400, r.Status);
            Assert.Contains("api/orders.sql: パラメーター :from の値がありません。read_api('orders', from = ...) と書きます", Encoding.UTF8.GetString(r.Body));
        }

        [SqlServerFact]
        public async Task StopsAtTheRowLimitALargerOneInTheSqlToo()
        {
            var e = await Assert.ThrowsAsync<ApiException>(() => db.Api().RunAsync("types", new Dictionary<string, object?> { ["from"] = "2000-01-01", ["skip"] = "-" }));
            Assert.Equal((422, "api/types.sql の結果が 2 行を超えました。SQL の WHERE で絞ってください"), (e.Status, e.Message));
            Assert.Equal(new[] { 1L, 2L }, (await SqlServer.Query("SELECT id FROM devbi_types ORDER BY id", 2)).Rows.Select(r => (long)r[0]!));
            Assert.Equal(new[] { 1L, 2L }, (await SqlServer.Query("SELECT TOP 1000 id FROM devbi_types ORDER BY id", 2)).Rows.Select(r => (long)r[0]!));
            // and the next query is fine
            Assert.Equal(new[] { 1L, 2L, 3L }, (await SqlServer.Query("SELECT TOP 1000 id FROM devbi_types ORDER BY id")).Rows.Select(r => (long)r[0]!));
        }

        [SqlServerFact]
        public async Task GivesUpAfterTheTimeLimit()
        {
            var watch = Stopwatch.StartNew();
            var e = await Assert.ThrowsAsync<TimeoutException>(() => SqlServer.Query("WAITFOR DELAY '00:00:05'; SELECT 1 AS one", timeout: TimeSpan.FromMilliseconds(500)));
            Assert.Equal("0.5 秒を過ぎたので止めました（x）", e.Message);
            Assert.True(watch.ElapsedMilliseconds < 4000, $"{watch.ElapsedMilliseconds} ms");
            // and the connection (back in the pool) still works
            Assert.Equal(1L, (await SqlServer.Query("SELECT 1 AS one")).Rows[0][0]);
            // through the API: a 500 that says so
            var dir = System.IO.Directory.CreateTempSubdirectory("devbi-mssql-slow-").FullName;
            System.IO.Directory.CreateDirectory(Path.Combine(dir, "api"));
            File.WriteAllText(Path.Combine(dir, "api", "slow.sql"), "WITH a AS (SELECT 1 AS n) SELECT COUNT_BIG(*) AS n FROM sys.all_objects a, sys.all_objects b, sys.all_objects c, sys.all_objects d");
            var api = new DevBIApi(new DevBIOptions { Directory = dir, Connect = _ => new SqlConnection(SqlServer.ConnectionString), Timeout = TimeSpan.FromMilliseconds(300) });
            var r = await api.HandleAsync(new ApiRequest { Action = "query", Method = "POST", ContentType = "application/json", Body = new MemoryStream(Encoding.UTF8.GetBytes("{\"name\":\"slow\"}")) });
            Assert.Equal(500, r.Status);
            Assert.Contains("api/slow.sql を実行できませんでした（くわしくはサーバーのログにあります）", Encoding.UTF8.GetString(r.Body));
        }

        [SqlServerFact]
        public async Task CannotChangeDataEvenWhenAskedToDirectlyNorTables()
        {
            var before = (await SqlServer.Query("SELECT COUNT(*) AS n FROM devbi_types")).Rows[0][0];
            // run directly (the API refuses them before they reach the database): undone with the transaction
            foreach (var sql in new[] { "INSERT INTO devbi_types (id) VALUES (99)", "DELETE FROM devbi_types", "INSERT INTO devbi_types (id) OUTPUT inserted.id VALUES (98)" })
            {
                try
                {
                    await SqlServer.Query(sql);
                }
                catch (Exception)
                {
                }
            }
            Assert.Equal(before, (await SqlServer.Query("SELECT COUNT(*) AS n FROM devbi_types")).Rows[0][0]);
            try
            {
                await SqlServer.Query("CREATE TABLE devbi_ddl_probe (id INT)");
            }
            catch (Exception)
            {
            }
            await Assert.ThrowsAnyAsync<Exception>(() => SqlServer.Query("SELECT * FROM devbi_ddl_probe"));
        }

        [SqlServerFact]
        public async Task RefusesDuplicateColumnNames()
        {
            var e = await Assert.ThrowsAsync<InvalidOperationException>(() => SqlServer.Query("SELECT id, id FROM devbi_types"));
            Assert.Equal("列名が重なっています: id（AS で別の名前を付けてください）", e.Message);
        }

        [SqlServerFact]
        public async Task ReadsForJsonAsOneTextValueAndASqlVariantHoldingADatetimeAsADatetime()
        {
            var json = await SqlServer.Query("SELECT id FROM devbi_types ORDER BY id FOR JSON PATH");
            Assert.Equal("[{\"id\":1},{\"id\":2},{\"id\":3}]", Assert.Single(json.Rows)[0]);
            // longer than one piece (about 2,000 characters)
            var long_ = await SqlServer.Query("SELECT TOP 500 o.order_no, o.order_date FROM orders o ORDER BY o.order_no FOR JSON PATH");
            var text = (string)Assert.Single(long_.Rows)[0]!;
            Assert.True(text.Length > 10_000);
            Assert.Equal(500, System.Text.Json.JsonDocument.Parse(text).RootElement.GetArrayLength());
            var v = await SqlServer.Query("SELECT CAST(CAST('2026-04-01 09:30' AS DATETIME2) AS sql_variant) AS v, CAST(CAST('09:30' AS TIME) AS sql_variant) AS t");
            Assert.Equal(new[] { (ColumnType.Timestamp, "v"), (ColumnType.String, "t") }, v.Columns.Select(c => (c.Type, c.Name)));
            Assert.Equal(new object?[] { Micros(new DateTime(2026, 4, 1, 9, 30, 0)), "09:30:00" }, Assert.Single(v.Rows));
        }

        [SqlServerFact]
        public async Task SendsNumbersPastDotNetsDecimalAsDoubles()
        {
            var r = await SqlServer.Query("SELECT CAST(1e30 AS DECIMAL(38,0)) AS huge, CAST(12.5 AS DECIMAL(38,10)) AS small, CAST(1.5 AS MONEY) AS m, CAST(0.25 AS REAL) AS r, CAST(7 AS TINYINT) AS ti");
            Assert.Equal(new[] { ColumnType.Float, ColumnType.Float, ColumnType.Float, ColumnType.Float, ColumnType.Int }, r.Columns.Select(c => c.Type));
            Assert.Equal(new object?[] { 1e30, 12.5, 1.5, 0.25, 7L }, Assert.Single(r.Rows));
        }
    }
}
