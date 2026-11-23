// The C# code reads, checks and binds SQL files the way the TypeScript code does: packages/server/test/
// sqlserver-parity.test.ts writes the TypeScript answers to packages/server/test/fixtures/sqlserver-cases.json.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace DevBI.Server.Tests
{
    public class ParityTests
    {
        private static readonly JsonSerializerOptions Readable = new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
        private static readonly JsonNode Cases = JsonNode.Parse(File.ReadAllText(Path.Combine(Repo.Root, "packages", "server", "test", "fixtures", "sqlserver-cases.json")))!;

        private static JsonObject ErrorOf(Exception e) =>
            e is DatasetException d ? new JsonObject { ["error"] = d.Message, ["status"] = d.Status } : new JsonObject { ["error"] = e.Message };

        private static JsonArray Strings(IEnumerable<string> items) => new JsonArray(items.Select(s => (JsonNode?)JsonValue.Create(s)).ToArray());

        private static JsonNode? Value(object? v) =>
            v switch
            {
                null => null,
                string s => JsonValue.Create(s),
                // past 2^53 JavaScript writes the double (1152921504606847000 for 2^60): the same number
                long l when Math.Abs(l) > 9007199254740991 => JsonValue.Create((double)l),
                long l => JsonValue.Create(l),
                double d => JsonValue.Create(d),
                bool b => JsonValue.Create(b),
                _ => throw new InvalidOperationException(v.GetType().Name),
            };

        /// <summary>A parameter as api/schema writes it.</summary>
        private static JsonNode ParameterJson(DatasetParameter p)
        {
            using var stream = new MemoryStream();
            using (var w = new System.Text.Json.Utf8JsonWriter(stream)) p.WriteJson(w);
            return JsonNode.Parse(stream.ToArray())!;
        }

        /// <summary>Each case's answer from the C# code next to the TypeScript one; the cases that differ.</summary>
        private static void Compare(string group, Func<JsonObject, (string label, JsonNode? expected, JsonNode? actual)> check)
        {
            var differ = new List<string>();
            var cases = Cases[group]!.AsArray();
            foreach (var c in cases)
            {
                var (label, expected, actual) = check(c!.AsObject());
                if (!JsonNode.DeepEquals(expected, actual)) differ.Add($"{label}\n  TypeScript: {expected?.ToJsonString(Readable)}\n  C#:         {actual?.ToJsonString(Readable)}");
            }
            Assert.True(differ.Count == 0, $"{differ.Count} / {cases.Count} differ:\n" + string.Join("\n", differ));
            Assert.NotEmpty(cases);
        }

        [Fact]
        public void SplitsFilesIntoStatements()
        {
            Compare("statements", c =>
            {
                var text = c["text"]!.GetValue<string>();
                var actual = new JsonArray(SqlText.SplitStatements(text).Select(s => (JsonNode?)new JsonObject { ["sql"] = s.Sql, ["title"] = s.Title, ["line"] = s.Line }).ToArray());
                return (JsonSerializer.Serialize(text), c["statements"], actual);
            });
        }

        [Fact]
        public void FindsWhatIsNotReadOnly()
        {
            Compare("problems", c =>
            {
                var sql = c["sql"]!.GetValue<string>();
                var p = SqlText.ReadOnlyProblem(sql);
                return (JsonSerializer.Serialize(sql), c["problem"], p == null ? null : new JsonObject { ["code"] = p.Code, ["word"] = p.Word });
            });
        }

        [Fact]
        public void FindsParameters()
        {
            Compare("parameters", c =>
            {
                var sql = c["sql"]!.GetValue<string>();
                var actual = new JsonArray(SqlText.Parameters(sql).Select(p => (JsonNode?)new JsonObject { ["name"] = p.Name, ["start"] = p.Start, ["end"] = p.End }).ToArray());
                return (JsonSerializer.Serialize(sql), c["parameters"], actual);
            });
        }

        [Fact]
        public void ReadsFiles()
        {
            Compare("datasets", c =>
            {
                var name = c["name"]!.GetValue<string>();
                var text = c["text"]!.GetValue<string>();
                JsonNode? snapshot;
                try
                {
                    var times = Dataset.SnapshotOf(text, name);
                    snapshot = times == null ? null : Strings(times);
                }
                catch (DatasetException e)
                {
                    snapshot = ErrorOf(e);
                }
                JsonNode dataset;
                try
                {
                    var d = Dataset.Parse(name, text);
                    dataset = new JsonObject
                    {
                        ["description"] = d.Description,
                        ["connection"] = d.Connection,
                        ["snapshot"] = d.Snapshot == null ? null : Strings(d.Snapshot),
                        ["sql"] = d.Sql,
                        ["params"] = Strings(d.Params),
                        ["parameters"] = new JsonArray(d.Parameters.Select(p => (JsonNode?)ParameterJson(p)).ToArray()),
                        ["key"] = d.Key == null ? null : Strings(d.Key),
                        ["user"] = d.User == null ? null : Strings(d.User),
                        ["roles"] = d.Roles == null ? null : Strings(d.Roles),
                        ["access"] = d.Access,
                    };
                }
                catch (DatasetException e)
                {
                    dataset = ErrorOf(e);
                }
                var expected = new JsonObject { ["header"] = c["header"]!.DeepClone(), ["dataset"] = c["dataset"]!.DeepClone() };
                var actual = new JsonObject { ["header"] = new JsonObject { ["connection"] = Dataset.ConnectionOf(text), ["snapshot"] = snapshot }, ["dataset"] = dataset };
                return (name, expected, actual);
            });
        }

        [Fact]
        public void ReadsTheLinesThatSayWhoMayRead()
        {
            Compare("access", c =>
            {
                var text = c["text"]!.GetValue<string>();
                JsonNode lines;
                try
                {
                    var l = Access.Read(text, "api/x.sql");
                    lines = new JsonObject { ["roles"] = l.Roles == null ? null : Strings(l.Roles), ["access"] = l.Access };
                }
                catch (AccessLineException e)
                {
                    lines = new JsonObject { ["error"] = e.Message };
                }
                var expected = new JsonObject { ["lines"] = c["lines"]!.DeepClone(), ["signal"] = c["signal"]?.DeepClone() };
                var actual = new JsonObject { ["lines"] = lines, ["signal"] = Access.RowLevelSignal(text) };
                return (JsonSerializer.Serialize(text), expected, actual);
            });
        }

        /// <summary>A JSON value as the API reads it from a request.</summary>
        private static object? ValueOf(JsonNode? v) => DevBIApi.ValueOf(JsonDocument.Parse(v?.ToJsonString() ?? "null").RootElement);

        [Fact]
        public void BindsParameters()
        {
            Compare("binds", c =>
            {
                var text = c["text"]!.GetValue<string>();
                // the values as the API reads them from a request's JSON
                var values = c["values"]!.AsObject().Select(p => new KeyValuePair<string, object?>(p.Key, ValueOf(p.Value))).ToList();
                // the user as the host hands it over
                DevBIUser? user = null;
                if (c["user"] is JsonObject u)
                {
                    user = new DevBIUser { Id = u["id"]!.GetValue<string>() };
                    if (u["attrs"] is JsonObject attrs)
                    {
                        foreach (var a in attrs) user.Attributes[a.Key] = ValueOf(a.Value);
                    }
                }
                var rowLevel = c["rowLevel"]?.GetValue<bool>() ?? false;
                JsonNode bound;
                try
                {
                    var b = Dataset.Parse("x", text).Bind(values, user, rowLevel);
                    bound = new JsonObject { ["sql"] = b.Sql, ["values"] = new JsonArray(b.Values.Select(Value).ToArray()) };
                }
                catch (DatasetException e)
                {
                    bound = ErrorOf(e);
                }
                return ($"{text} {c["values"]!.ToJsonString()}", c["bound"], bound);
            });
        }
    }
}
