// The -- param: and -- key: lines at the top of an api/<name>.sql file, and the checks the values sent for a typed
// parameter go through. A port of packages/server/src/params.ts (the messages are the same, word for word).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace DevBI.Server
{
    /// <summary>One parameter of a dataset, as <c>GET api/schema</c> lists it.</summary>
    public sealed class DatasetParameter
    {
        internal DatasetParameter(string name)
        {
            Name = name;
        }

        /// <summary>As the <c>-- param:</c> line writes it (or, without one, as the SQL first writes it).</summary>
        public string Name { get; }

        /// <summary><c>text</c>, <c>integer</c>, <c>number</c>, <c>date</c>, <c>datetime</c> or <c>boolean</c>. Null: no <c>-- param:</c> line.</summary>
        public string? Type { get; internal set; }

        /// <summary><c>text[]</c>: several values, for <c>IN (:name)</c>.</summary>
        public bool Multiple { get; internal set; }

        /// <summary>The input's name. Null: the parameter's name.</summary>
        public string? Label { get; internal set; }

        /// <summary>As written (<c>month_start</c>, <c>all</c>, <c>関東,近畿</c>): the browser reads it, not the server.</summary>
        public string? Default { get; internal set; }

        /// <summary>The dataset whose rows are the choices.</summary>
        public string? Values { get; internal set; }

        /// <summary>May be empty: NULL goes to the database.</summary>
        public bool Optional { get; internal set; }

        /// <summary>No input (the value comes from the URL, the embedding page or a click).</summary>
        public bool Hidden { get; internal set; }

        /// <summary>Writes the keys that are set, in the order <c>api/schema</c> has them.</summary>
        internal void WriteJson(Utf8JsonWriter w)
        {
            w.WriteStartObject();
            w.WriteString("name", Name);
            if (Type != null) w.WriteString("type", Type);
            if (Multiple) w.WriteBoolean("multiple", true);
            if (Label != null) w.WriteString("label", Label);
            if (Default != null) w.WriteString("default", Default);
            if (Values != null) w.WriteString("values", Values);
            if (Optional) w.WriteBoolean("optional", true);
            if (Hidden) w.WriteBoolean("hidden", true);
            w.WriteEndObject();
        }
    }

    /// <summary>The reading of the lines, and the checks of the values.</summary>
    internal static class ParamLines
    {
        internal static readonly string[] Types = { "text", "integer", "number", "date", "datetime", "boolean" };
        private static readonly string[] Options = { "label", "default", "values", "optional", "hidden" };

        /// <summary>Most characters (UTF-16 code units) in one text value.</summary>
        internal const int MaxText = 4000;
        /// <summary>Most values in one multiple-value parameter.</summary>
        internal const int MaxValues = 1000;
        /// <summary>Most placeholders in one statement.</summary>
        internal const int MaxPlaceholders = 2000;

        private const string TypesHint = "text・integer・number・date・datetime・boolean のどれかを書いてください（複数の値は text[] のように）";
        private const string Line = "[^\\n\\r\\u2028\\u2029]*";

        // `user` in ASCII letters only, as JavaScript's /…/i without u reads it
        internal static readonly Regex Reserved = new Regex("^[Uu][Ss][Ee][Rr]\\.", RegexOptions.CultureInvariant);
        private static readonly Regex Name = new Regex("^[A-Za-z_\\u0080-\\uffff][A-Za-z0-9_\\u0080-\\uffff]*\\z", RegexOptions.CultureInvariant);
        private static readonly Regex ParamLine = new Regex($"^[{SqlText.Space}]*--[{SqlText.Space}]*param[{SqlText.Space}]*:({Line})\\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex KeyLine = new Regex($"^[{SqlText.Space}]*--[{SqlText.Space}]*key[{SqlText.Space}]*:({Line})\\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex CommentLine = new Regex($"^[{SqlText.Space}]*--", RegexOptions.CultureInvariant);
        private static readonly Regex DayWords = new Regex("^(today|tomorrow|yesterday|month_start|next_month_start|previous_month_start|year_start|fiscal_year_start)([+-][0-9]{1,5})?\\z", RegexOptions.CultureInvariant);
        private static readonly Regex Integer = new Regex("^[+-]?[0-9]+\\z", RegexOptions.CultureInvariant);
        private static readonly Regex Decimal = new Regex("^[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]+)?\\z", RegexOptions.CultureInvariant);
        private static readonly Regex Date = new Regex("^([0-9]{4})-([0-9]{2})-([0-9]{2})\\z", RegexOptions.CultureInvariant);
        private static readonly Regex DateTime = new Regex("^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(\\.[0-9]{1,6})?)?\\z", RegexOptions.CultureInvariant);

        private static readonly Dictionary<string, string> Examples = new Dictionary<string, string>
        {
            ["text"] = "受付",
            ["integer"] = "10",
            ["number"] = "1.5",
            ["date"] = "2024-04-01 か month_start、today-30",
            ["datetime"] = "2024-04-01T09:00 か today",
            ["boolean"] = "true か false",
        };

        private static readonly Dictionary<string, string> Wants = new Dictionary<string, string>
        {
            ["text"] = "文字",
            ["integer"] = "整数",
            ["number"] = "数値",
            ["date"] = "日付（'2024-04-01' の形の文字）",
            ["datetime"] = "日時（'2024-04-01T09:00' の形の文字）",
            ["boolean"] = "真偽（true か false）",
        };

        internal sealed class LineException : Exception
        {
            public LineException(string message) : base(message)
            {
            }
        }

        private struct Word
        {
            public string Key;
            /// <summary>Null: no <c>=</c>.</summary>
            public string? Value;
        }

        /// <summary>The words of a <c>-- param:</c> line: <c>name type key=value "a b"</c>.</summary>
        private static List<Word> Words(string body)
        {
            var output = new List<Word>();
            var i = 0;
            while (i < body.Length)
            {
                if (SqlText.IsSpace(body[i]))
                {
                    i++;
                    continue;
                }
                var cur = new StringBuilder();
                string? key = null;
                while (i < body.Length && !SqlText.IsSpace(body[i]))
                {
                    var c = body[i];
                    if (c == '"')
                    {
                        var j = i + 1;
                        for (; ; )
                        {
                            if (j >= body.Length) throw new LineException("\" が閉じていません");
                            if (body[j] == '"')
                            {
                                if (j + 1 < body.Length && body[j + 1] == '"')
                                {
                                    cur.Append('"');
                                    j += 2;
                                    continue;
                                }
                                break;
                            }
                            cur.Append(body[j]);
                            j++;
                        }
                        i = j + 1;
                        continue;
                    }
                    if (c == '=' && key == null)
                    {
                        key = cur.ToString();
                        cur.Clear();
                        i++;
                        continue;
                    }
                    cur.Append(c);
                    i++;
                }
                output.Add(key == null ? new Word { Key = cur.ToString() } : new Word { Key = key, Value = cur.ToString() });
            }
            return output;
        }

        private static bool LiteralFits(string text, string type)
        {
            switch (type)
            {
                case "text":
                    return true;
                case "integer":
                    return Integer.IsMatch(text) && SafeInteger(text);
                case "number":
                    return Decimal.IsMatch(text) && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && !double.IsInfinity(d) && !double.IsNaN(d);
                case "date":
                    return DayWords.IsMatch(text) || DateText(text) != null;
                case "datetime":
                    return DayWords.IsMatch(text) || DatetimeText(text) != null;
                default:
                    return text == "true" || text == "false";
            }
        }

        /// <summary>Whole-number text that JavaScript's Number reads as a safe integer.</summary>
        private static bool SafeInteger(string text)
        {
            var digits = text.TrimStart('+', '-').TrimStart('0');
            if (digits.Length > 16) return false;
            return digits.Length == 0 || long.Parse(digits, CultureInfo.InvariantCulture) <= 9007199254740991L;
        }

        private static void CheckDefault(DatasetParameter def, string text)
        {
            var type = def.Multiple ? def.Type + "[]" : def.Type!;
            if (def.Multiple)
            {
                if (text == "all" && def.Values != null) return;
                var items = text.Split(',').Select(SqlText.Trim).ToList();
                if (items.Any(s => s.Length == 0)) throw new LineException($"default={text} に空の値があります（, で区切って書きます）");
                var bad = items.FirstOrDefault(s => !LiteralFits(s, def.Type!));
                if (bad != null) throw new LineException($"default の {bad} は {type} の値として読めません（例: {Examples[def.Type!]}）");
                return;
            }
            if (text.Length == 0 && def.Type != "text") throw new LineException($"default に値を書いてください（例: default={Examples[def.Type!].Split(' ')[0]}）");
            if (!LiteralFits(text, def.Type!)) throw new LineException($"default={text} は {type} の値として読めません（例: {Examples[def.Type!]}）");
        }

        private static DatasetParameter ParseParamLine(string body)
        {
            var ws = Words(body);
            if (ws.Count == 0 || ws[0].Value != null) throw new LineException("-- param: のあとにパラメーターの名前と型を書いてください（例: -- param: from date）");
            var name = ws[0].Key;
            if (Reserved.IsMatch(name)) throw new LineException($"{name}: user. で始まる名前は、ログインした人の値のために取ってあるので使えません");
            if (!Name.IsMatch(name)) throw new LineException($"{name} はパラメーターの名前として読めません（SQL の :名前 の名前を書きます）");
            if (ws.Count < 2) throw new LineException($"パラメーター {name} の型がありません。{TypesHint}");
            var second = ws[1];
            if (second.Value != null) throw new LineException($"パラメーター {name} の型がありません（名前と型のあとに label=… などを書きます）。{TypesHint}");
            var multiple = second.Key.EndsWith("[]", StringComparison.Ordinal);
            var typeName = multiple ? second.Key.Substring(0, second.Key.Length - 2) : second.Key;
            if (!Types.Contains(typeName)) throw new LineException($"型 {second.Key} は使えません。{TypesHint}");
            var def = new DatasetParameter(name) { Type = typeName, Multiple = multiple };
            var seen = new HashSet<string>(StringComparer.Ordinal);
            string? defaultText = null;
            foreach (var w in ws.Skip(2))
            {
                var key = w.Key;
                if (!Options.Contains(key)) throw new LineException($"{key} は知らない指定です。{string.Join("・", Options)} を書けます");
                if (!seen.Add(key)) throw new LineException($"{key} が 2 回あります");
                if (key == "optional" || key == "hidden")
                {
                    if (w.Value != null) throw new LineException($"{key} は値を付けずに書きます");
                    if (key == "optional")
                    {
                        if (multiple) throw new LineException($"複数の値（{second.Key}）には optional を付けられません（1 つも選ばないことはできません）");
                        def.Optional = true;
                    }
                    else
                    {
                        def.Hidden = true;
                    }
                    continue;
                }
                if (w.Value == null) throw new LineException($"{key} には値を書いてください（{key}=…）");
                if (key == "label")
                {
                    if (w.Value.Length == 0) throw new LineException("label に名前を書いてください");
                    def.Label = w.Value;
                }
                else if (key == "values")
                {
                    if (w.Value.Length == 0 || w.Value.IndexOf('/') >= 0 || w.Value.IndexOf('\\') >= 0)
                    {
                        throw new LineException($"values には候補を出すデータセットの名前（api/ の SQL ファイルの名前）を書きます（{w.Value}）");
                    }
                    def.Values = w.Value;
                }
                else
                {
                    defaultText = w.Value;
                }
            }
            if (defaultText != null)
            {
                CheckDefault(def, defaultText);
                def.Default = defaultText;
            }
            return def;
        }

        private static string ReadQuoted(string body, ref int i)
        {
            var name = new StringBuilder();
            var j = i + 1;
            for (; ; )
            {
                if (j >= body.Length) throw new LineException("\" が閉じていません");
                if (body[j] == '"')
                {
                    if (j + 1 < body.Length && body[j + 1] == '"')
                    {
                        name.Append('"');
                        j += 2;
                        continue;
                    }
                    break;
                }
                name.Append(body[j]);
                j++;
            }
            i = j + 1;
            return name.ToString();
        }

        private static List<string> ParseKeyLine(string body)
        {
            var columns = new List<string>();
            var cur = new StringBuilder();
            var quoted = false;
            void Finish()
            {
                var name = quoted ? cur.ToString() : SqlText.Trim(cur.ToString());
                if (name.Length == 0) throw new LineException("-- key: のあとに、行を見分ける列の名前を , で区切って書いてください（例: -- key: 受注番号, 行番号）");
                if (columns.Contains(name)) throw new LineException($"列 {name} が 2 回あります");
                columns.Add(name);
                cur.Clear();
                quoted = false;
            }
            var i = 0;
            while (i < body.Length)
            {
                var c = body[i];
                if (c == '"' && SqlText.Trim(cur.ToString()).Length == 0 && !quoted)
                {
                    var name = ReadQuoted(body, ref i);
                    cur.Clear().Append(name);
                    quoted = true;
                    while (i < body.Length && SqlText.IsSpace(body[i])) i++;
                    if (i < body.Length && body[i] != ',' && body[i] != '、') throw new LineException($"\"{name}\" のあとは , で区切ります");
                    continue;
                }
                if (c == ',' || c == '、')
                {
                    Finish();
                    i++;
                    continue;
                }
                if (quoted) throw new LineException($"\"{cur}\" のあとは , で区切ります");
                cur.Append(c);
                i++;
            }
            Finish();
            return columns;
        }

        /// <summary>
        /// The <c>-- param:</c> and <c>-- key:</c> lines among the comment lines at the top of the file, checked against
        /// the SQL's parameter names. Throws <see cref="DatasetException"/> (400) with <c>api/&lt;name&gt;.sql（N 行目）: …</c>.
        /// </summary>
        internal static (List<DatasetParameter> parameters, List<string>? key) HeaderDirectives(string text, string name, IReadOnlyList<string> sqlParams, string? rel = null)
        {
            rel ??= $"api/{name}.sql";
            var parameters = new List<(DatasetParameter def, int line)>();
            (List<string> columns, int line)? key = null;
            var lines = Regex.Split(text.Length > 0 && text[0] == '﻿' ? text.Substring(1) : text, "\r?\n");
            for (var i = 0; i < lines.Length; i++)
            {
                var line = lines[i];
                if (SqlText.Trim(line).Length > 0 && !CommentLine.IsMatch(line))
                {
                    // a -- param: or -- key: past the header (after a /* */ or in the SQL) would do nothing: say so
                    for (var j = i; j < lines.Length; j++)
                    {
                        var late = ParamLine.IsMatch(lines[j]) ? "-- param:" : KeyLine.IsMatch(lines[j]) ? "-- key:" : null;
                        if (late != null)
                        {
                            throw new DatasetException($"{rel}（{j + 1} 行目）: {late} は、ファイルの先頭から続く -- のコメントの中に書いてください（SQL や /* */ よりあとの行は読みません）", 400);
                        }
                    }
                    break;
                }
                try
                {
                    var p = ParamLine.Match(line);
                    if (p.Success)
                    {
                        var def = ParseParamLine(p.Groups[1].Value);
                        var lower = def.Name.ToLowerInvariant();
                        var twice = parameters.FindIndex(q => q.def.Name.ToLowerInvariant() == lower);
                        if (twice >= 0) throw new LineException($"パラメーター {def.Name} の -- param: が 2 つあります（{parameters[twice].line} 行目にも）");
                        if (!sqlParams.Any(s => s.ToLowerInvariant() == lower))
                        {
                            throw new LineException($"パラメーター {def.Name} は SQL にありません（SQL に :{def.Name} と書くか、この行を消してください）");
                        }
                        parameters.Add((def, i + 1));
                        continue;
                    }
                    var k = KeyLine.Match(line);
                    if (k.Success)
                    {
                        if (key != null) throw new LineException($"-- key: が 2 つあります（{key.Value.line} 行目にも）");
                        key = (ParseKeyLine(k.Groups[1].Value), i + 1);
                    }
                }
                catch (LineException e)
                {
                    throw new DatasetException($"{rel}（{i + 1} 行目）: {e.Message}", 400);
                }
            }
            return (parameters.Select(p => p.def).ToList(), key?.columns);
        }

        /// <summary><c>YYYY-MM-DD</c> when the text is a date on the calendar (years 1 to 9999), otherwise null.</summary>
        internal static string? DateText(string text)
        {
            var m = Date.Match(text);
            if (!m.Success) return null;
            var y = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            var mo = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
            var d = int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture);
            if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
            return d <= System.DateTime.DaysInMonth(y, mo) ? text : null;
        }

        /// <summary><c>YYYY-MM-DD HH:MM:SS[.ffffff]</c> for a date and time without a time zone, or a date (midnight). Otherwise null.</summary>
        internal static string? DatetimeText(string text)
        {
            if (DateText(text) != null) return text + " 00:00:00";
            var m = DateTime.Match(text);
            if (!m.Success || DateText(m.Groups[1].Value) == null) return null;
            int Part(int g) => m.Groups[g].Success ? int.Parse(m.Groups[g].Value, CultureInfo.InvariantCulture) : 0;
            if (Part(2) > 23 || Part(3) > 59 || Part(4) > 59) return null;
            return $"{m.Groups[1].Value} {m.Groups[2].Value}:{m.Groups[3].Value}:{(m.Groups[4].Success ? m.Groups[4].Value : "00")}{(m.Groups[5].Success ? m.Groups[5].Value : "")}";
        }

        /// <summary>A value the way JavaScript's <c>JSON.stringify</c> writes it, cut at 40 characters.</summary>
        internal static string Shown(object? v)
        {
            var s = Js(v);
            if (s.Length <= 40) return s;
            // not between the two halves of a surrogate pair (𠮷, emoji)
            return s.Substring(0, char.IsHighSurrogate(s[39]) ? 39 : 40) + "…";
        }

        /// <summary>JavaScript's <c>JSON.stringify</c> of a value read from a request.</summary>
        private static string Js(object? v) =>
            v switch
            {
                null => "null",
                string t => JsString(t),
                bool b => b ? "true" : "false",
                long l => l.ToString(CultureInfo.InvariantCulture),
                double d => JsNumber(d),
                JsonElement e => Js(e),
                IList list => "[" + string.Join(",", list.Cast<object?>().Select(Js)) + "]",
                _ => v.ToString() ?? "",
            };

        private static string Js(JsonElement e) =>
            e.ValueKind switch
            {
                JsonValueKind.String => JsString(e.GetString()!),
                // past the double range JavaScript reads Infinity, which JSON.stringify writes as null
                JsonValueKind.Number => e.TryGetDouble(out var d) ? JsNumber(d) : "null",
                JsonValueKind.True => "true",
                JsonValueKind.False => "false",
                JsonValueKind.Array => "[" + string.Join(",", e.EnumerateArray().Select(Js)) + "]",
                JsonValueKind.Object => "{" + string.Join(",", e.EnumerateObject().Select(p => JsString(p.Name) + ":" + Js(p.Value))) + "}",
                _ => "null",
            };

        /// <summary>A string as <c>JSON.stringify</c> writes it: only quotes, backslashes, control characters and lone surrogates escaped.</summary>
        private static string JsString(string t)
        {
            var b = new StringBuilder(t.Length + 2).Append('"');
            for (var i = 0; i < t.Length; i++)
            {
                var c = t[i];
                switch (c)
                {
                    case '"': b.Append("\\\""); break;
                    case '\\': b.Append("\\\\"); break;
                    case '\b': b.Append("\\b"); break;
                    case '\f': b.Append("\\f"); break;
                    case '\n': b.Append("\\n"); break;
                    case '\r': b.Append("\\r"); break;
                    case '\t': b.Append("\\t"); break;
                    default:
                        if (c < 0x20 || (char.IsHighSurrogate(c) && !(i + 1 < t.Length && char.IsLowSurrogate(t[i + 1]))) || (char.IsLowSurrogate(c) && !(i > 0 && char.IsHighSurrogate(t[i - 1]))))
                        {
                            b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            b.Append(c);
                        }
                        break;
                }
            }
            return b.Append('"').ToString();
        }

        /// <summary>JavaScript's way of writing a double: the shortest digits, with an exponent from 1e21 and below 1e-6.</summary>
        internal static string JsNumber(double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) return "null";
            if (d == 0) return "0";
            var r = d.ToString("R", CultureInfo.InvariantCulture);
            var negative = r.StartsWith("-", StringComparison.Ordinal);
            if (negative) r = r.Substring(1);
            var e = r.IndexOfAny(new[] { 'E', 'e' });
            var exponent = e >= 0 ? int.Parse(r.Substring(e + 1), CultureInfo.InvariantCulture) : 0;
            var mantissa = e >= 0 ? r.Substring(0, e) : r;
            var dot = mantissa.IndexOf('.');
            var digits = mantissa.Replace(".", "");
            // the decimal point's place in the digits
            var point = (dot >= 0 ? dot : mantissa.Length) + exponent;
            var lead = digits.Length - digits.TrimStart('0').Length;
            digits = digits.Trim('0');
            point -= lead;
            if (digits.Length == 0) return "0";
            string text;
            if (point > 21 || point < -5)
            {
                var exp = point - 1;
                text = digits.Substring(0, 1) + (digits.Length > 1 ? "." + digits.Substring(1) : "") + "e" + (exp >= 0 ? "+" : "-") + Math.Abs(exp).ToString(CultureInfo.InvariantCulture);
            }
            else if (point <= 0)
            {
                text = "0." + new string('0', -point) + digits;
            }
            else if (point >= digits.Length)
            {
                text = digits + new string('0', point - digits.Length);
            }
            else
            {
                text = digits.Substring(0, point) + "." + digits.Substring(point);
            }
            return negative ? "-" + text : text;
        }

        /// <summary>
        /// The value for a typed parameter, checked and in the form it goes to the database in (see params.ts's
        /// checkValue): a list for a multiple-value parameter. Throws <see cref="DatasetException"/> (400).
        /// </summary>
        internal static object? CheckValue(string rel, DatasetParameter def, object? v)
        {
            object? One(object? x, bool inList)
            {
                if (x == null)
                {
                    if (inList) throw new DatasetException($"{rel}: パラメーター {def.Name} の値に null は入れられません", 400);
                    if (!def.Optional) throw new DatasetException($"{rel}: パラメーター {def.Name} の値がありません（null にできるのは -- param: に optional を付けたパラメーターだけです）", 400);
                    return null;
                }
                DatasetException Wrong() => new DatasetException($"{rel}: パラメーター {def.Name} には{Wants[def.Type!]}を渡してください（{Shown(x)} が来ました）", 400);
                switch (def.Type)
                {
                    case "text":
                        if (!(x is string s)) throw Wrong();
                        if (s.Length > MaxText) throw new DatasetException($"{rel}: パラメーター {def.Name} の文字が長すぎます（{MaxText.ToString("N0", CultureInfo.InvariantCulture)} 文字まで）", 400);
                        return s;
                    case "integer":
                        if (!(x is long l) || l > 9007199254740991L || l < -9007199254740991L) throw Wrong();
                        return l;
                    case "number":
                        if (x is long) return x;
                        if (!(x is double d) || double.IsInfinity(d) || double.IsNaN(d)) throw Wrong();
                        return d;
                    case "date":
                        return (x is string ds ? DateText(ds) : null) ?? throw Wrong();
                    case "datetime":
                        return (x is string ts ? DatetimeText(ts) : null) ?? throw Wrong();
                    default:
                        if (!(x is bool)) throw Wrong();
                        return x;
                }
            }
            var isList = v is IList && !(v is string);
            if (!def.Multiple)
            {
                if (isList) throw new DatasetException($"{rel}: パラメーター {def.Name} は 1 つの値です（複数の値にするには -- param: の型を {def.Type}[] にします）", 400);
                return One(v, false);
            }
            var items = isList ? ((IList)v!).Cast<object?>().ToList() : v == null ? new List<object?>() : new List<object?> { v };
            if (items.Count == 0) throw new DatasetException($"{rel}: パラメーター {def.Name} に 1 つ以上の値を渡してください", 400);
            if (items.Count > MaxValues)
            {
                throw new DatasetException(
                    $"{rel}: パラメーター {def.Name} の値が {items.Count.ToString("N0", CultureInfo.InvariantCulture)} 個あります。1 つのパラメーターに渡せるのは {MaxValues.ToString("N0", CultureInfo.InvariantCulture)} 個までです。候補を絞るか、すべてのときはこのパラメーターを使わない SQL にしてください",
                    400);
            }
            return items.Select(x => One(x, true)).ToList();
        }
    }
}
