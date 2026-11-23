// Row-level security (docs/design/row-level-security.md): who is looking, and the lines of an api/*.sql file that say
// who may read it. DevBI does not sign anyone in: the host (ASP.NET Core's HttpContext.User, IIS's Windows
// authentication) does, and hands the API the signed-in user. The rows are filtered in the server's SQL, by
// :user.<attribute> and :user.id, never in the browser. A port of packages/server/src/access.ts (the messages are the
// same, word for word, but for the names of the C# properties).
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace DevBI.Server
{
    /// <summary>The signed-in user, as the host hands it to the API (<see cref="ApiRequest.User"/>, <see cref="DevBIApi.RunAsync(string, IEnumerable{KeyValuePair{string, object}}, DevBIUser, System.Threading.CancellationToken)"/>).</summary>
    public sealed class DevBIUser
    {
        /// <summary>
        /// The user's id, one that does not change and that nobody else can take: Entra ID's <c>oid</c>, OpenID Connect's
        /// <c>sub</c>, the Windows account (<c>CORP\yamada</c>). Not an e-mail address. <c>:user.id</c> in SQL. Null, empty
        /// or only spaces: not signed in.
        /// </summary>
        public string? Id { get; set; }

        /// <summary>
        /// Whether the user has a role, for <c>-- roles:</c> lines: <c>ClaimsPrincipal.IsInRole</c> (Windows groups, the
        /// app's roles) as it is. Null: no roles from the host (<c>access/user.sql</c>'s <c>roles</c> still count).
        /// </summary>
        public Func<string, bool>? IsInRole { get; set; }

        /// <summary>
        /// Attributes, one value each (text, a number or a boolean): <c>:user.&lt;name&gt;</c> in SQL, names without
        /// regard to case. Null, empty or only spaces: the user has no such attribute (and one of the same name from
        /// <c>access/user.sql</c> is not used either). A name that is not here: <c>access/user.sql</c>'s value counts.
        /// </summary>
        public IDictionary<string, object?> Attributes { get; set; } = new Dictionary<string, object?>();
    }

    /// <summary>What <c>access/user.sql</c> says of a user: its attributes and roles (an empty one when it returns no row).</summary>
    internal sealed class TableUser
    {
        public Dictionary<string, object?> Attrs { get; } = new Dictionary<string, object?>(StringComparer.Ordinal);
        public List<string> Roles { get; } = new List<string>();
    }

    /// <summary>
    /// A user as the server checks it: the id trimmed, attributes by lower-case name (null where the host said the user
    /// has none), roles from the host's <see cref="DevBIUser.IsInRole"/> and from <c>access/user.sql</c>.
    /// </summary>
    internal sealed class Viewer
    {
        private readonly Func<string, bool>? isInRole;
        private readonly HashSet<string> roles;

        private Viewer(string id, Func<string, bool>? isInRole, HashSet<string> roles, Dictionary<string, object?> attrs)
        {
            Id = id;
            this.isInRole = isInRole;
            this.roles = roles;
            Attrs = attrs;
        }

        public string Id { get; }

        /// <summary>Lower-case name → value; null: none.</summary>
        public IReadOnlyDictionary<string, object?> Attrs { get; }

        /// <summary>Whether the user has the role: the host's (<see cref="DevBIUser.IsInRole"/>) or <c>access/user.sql</c>'s. Matched as the host matches.</summary>
        public bool HasRole(string role) => roles.Contains(role) || (isInRole != null && isInRole(role));

        /// <summary>
        /// The user the host handed over, checked: null when there is none (not signed in: null, or an empty
        /// <see cref="DevBIUser.Id"/>). Throws <see cref="ArgumentException"/> for a wrong attribute (a mistake in the host's code).
        /// </summary>
        public static Viewer? Of(DevBIUser? user)
        {
            if (user == null) return null;
            var id = SqlText.Trim(user.Id ?? "");
            if (id.Length == 0) return null;
            var attrs = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var pair in user.Attributes ?? new Dictionary<string, object?>())
            {
                Access.CheckAttrName(pair.Key, () => $"DevBIUser.Attributes の {pair.Key}");
                var lower = pair.Key.ToLowerInvariant();
                if (attrs.ContainsKey(lower)) throw new ArgumentException($"DevBIUser.Attributes に {pair.Key} が 2 つあります（大文字と小文字は区別しません）");
                attrs[lower] = Access.AttrValue(pair.Value, () => $"DevBIUser.Attributes の {pair.Key}");
            }
            return new Viewer(id, user.IsInRole, new HashSet<string>(StringComparer.Ordinal), attrs);
        }

        /// <summary>Only the id: for <c>access/user.sql</c> (which may use <c>:user.id</c> only).</summary>
        public static Viewer IdOnly(string id) => new Viewer(id, null, new HashSet<string>(StringComparer.Ordinal), new Dictionary<string, object?>(StringComparer.Ordinal));

        /// <summary>
        /// The host's user with what <c>access/user.sql</c> says (docs/design 5 章): the id is the host's; a role either
        /// gives counts; an attribute is the host's when the host gives it (even as null, which means none), otherwise the table's.
        /// </summary>
        public Viewer With(TableUser? table)
        {
            if (table == null) return this;
            var merged = new Dictionary<string, object?>(table.Attrs, StringComparer.Ordinal);
            foreach (var pair in Attrs) merged[pair.Key] = pair.Value;
            return new Viewer(Id, isInRole, new HashSet<string>(roles.Concat(table.Roles), StringComparer.Ordinal), merged);
        }
    }

    /// <summary>The lines of an <c>api/*.sql</c> file that say who may read it.</summary>
    public sealed class AccessLines
    {
        internal AccessLines(IReadOnlyList<string>? roles, string? access)
        {
            Roles = roles;
            Access = access;
        }

        /// <summary><c>-- roles: 経理, CORP\Managers</c>: only users with one of these roles may read it. Null: no such line.</summary>
        public IReadOnlyList<string>? Roles { get; }

        /// <summary><c>-- access: all</c>: on purpose, every signed-in user gets every row. Null: no such line.</summary>
        public string? Access { get; }
    }

    /// <summary>An error in an <c>-- roles:</c> or <c>-- access:</c> line (the message has the file and the line).</summary>
    public sealed class AccessLineException : Exception
    {
        public AccessLineException(string message) : base(message)
        {
        }
    }

    public static class Access
    {
        private const string S = SqlText.Space;
        // JavaScript's /…/i without u: ASCII letters only, without regard to case (the C# reference reads them the same way)
        private const string Roles = "[Rr][Oo][Ll][Ee][Ss]";
        private const string AccessWord = "[Aa][Cc][Cc][Ee][Ss][Ss]";
        // JavaScript's . and $ (without m): no line breaks, and the end of the text only
        private const string Rest = "([^\\n\\r\\u2028\\u2029]*)\\z";

        private static readonly Regex RolesLine = new Regex($"^[{S}]*--[{S}]*{Roles}[{S}]*:{Rest}", RegexOptions.CultureInvariant);
        private static readonly Regex AccessLine = new Regex($"^[{S}]*--[{S}]*{AccessWord}[{S}]*:{Rest}", RegexOptions.CultureInvariant);
        private static readonly Regex CommentLine = new Regex($"^[{S}]*--", RegexOptions.CultureInvariant);
        /// <summary>The first word of a comment line, and whether a <c>:</c> follows it.</summary>
        private static readonly Regex FirstWord = new Regex($"^[{S}]*--[{S}]*([A-Za-z_]+)([{S}]*:)?", RegexOptions.CultureInvariant);
        /// <summary><c>roles:</c> / <c>access:</c> anywhere in a line (not <c>access::text</c>, PostgreSQL's cast).</summary>
        private static readonly Regex LateLine = new Regex($"(?:^|[^A-Za-z0-9_])({Roles}|{AccessWord})[{S}]*:(?!:)", RegexOptions.CultureInvariant);
        private static readonly Regex AccessAll = new Regex($"^[{S}]*--[{S}]*{AccessWord}[{S}]+[Aa][Ll][Ll](?![A-Za-z0-9_])", RegexOptions.CultureInvariant);
        private static readonly Regex UserDot = new Regex(":[Uu][Ss][Ee][Rr]\\.", RegexOptions.CultureInvariant);
        /// <summary>JavaScript's <c>split(/\r?\n|\r|\u2028|\u2029/)</c>.</summary>
        private static readonly Regex AnyLineBreak = new Regex("\\r?\\n|\\r|\\u2028|\\u2029", RegexOptions.CultureInvariant);
        private static readonly char[] RoleSeparators = { ',', '、' };

        /// <summary>Whether a parameter's name is the signed-in user's (<c>user.region</c>): <c>user.</c> in ASCII letters, without regard to case.</summary>
        public static bool IsUserName(string name) => name.Length >= 5 && IsUserWord(name, 0) && name[4] == '.';

        /// <summary>The bare name <c>user</c> (ASCII letters, without regard to case): refused in row-level mode, where it is likely a mistake for <c>user.id</c>.</summary>
        public static bool IsBareUser(string name) => name.Length == 4 && IsUserWord(name, 0);

        /// <summary>Whether <c>s[i..i+4)</c> is <c>user</c> in ASCII letters, without regard to case.</summary>
        internal static bool IsUserWord(string s, int i) =>
            i + 4 <= s.Length && (s[i] | 0x20) == 'u' && (s[i + 1] | 0x20) == 's' && (s[i + 2] | 0x20) == 'e' && (s[i + 3] | 0x20) == 'r';

        internal static void CheckAttrName(string name, Func<string> what)
        {
            if (name.Length == 2 && (name[0] | 0x20) == 'i' && (name[1] | 0x20) == 'd') throw new ArgumentException($"{what()}: id は属性の名前に使えません（:user.id はログインした人の ID です）");
            bool Letter(char c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || c >= '\u0080';
            if (name.Length == 0 || !Letter(name[0]) || !name.All(c => Letter(c) || (c >= '0' && c <= '9')))
            {
                throw new ArgumentException($"{what()}: 属性の名前は文字・数字・_ で書きます（:user.{name} と書けない名前です）");
            }
        }

        /// <summary>An attribute's value as it reaches the database (text, <see cref="long"/>, <see cref="double"/>, <see cref="bool"/>), or null when it counts as none (null, empty, only spaces).</summary>
        internal static object? AttrValue(object? v, Func<string> what)
        {
            switch (v)
            {
                case null:
                    return null;
                case string s:
                    return SqlText.Trim(s).Length == 0 ? null : s;
                case bool b:
                    return b;
                case int _:
                case long _:
                case short _:
                case byte _:
                case sbyte _:
                case ushort _:
                case uint _:
                    return Convert.ToInt64(v, System.Globalization.CultureInfo.InvariantCulture);
                case ulong u:
                    return u <= long.MaxValue ? (object)(long)u : (double)u;
                case float _:
                case double _:
                case decimal _:
                    var d = Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture);
                    if (double.IsNaN(d) || double.IsInfinity(d)) throw new ArgumentException($"{what()} の値が数として読めません（{d.ToString(System.Globalization.CultureInfo.InvariantCulture)}）");
                    // whole numbers as BIGINT up to its limit, as the API's parameters
                    return Math.Floor(d) == d && Math.Abs(d) < 9223372036854775808.0 ? (object)(long)d : d;
                default:
                    throw new ArgumentException($"{what()} の値は文字・数値・真偽のどれかにしてください");
            }
        }

        /// <summary>The row <c>access/user.sql</c> returned (columns and values), as attributes and roles. Throws <see cref="ArgumentException"/>.</summary>
        internal static TableUser TableUserOf(IReadOnlyList<ResultColumn> columns, object?[]? row)
        {
            var output = new TableUser();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 0; i < columns.Count; i++)
            {
                var name = columns[i].Name;
                var what = $"access/user.sql の列 {name}";
                var lower = name.ToLowerInvariant();
                if (!seen.Add(lower)) throw new ArgumentException($"{what} が 2 つあります（大文字と小文字は区別しません）");
                var v = row?[i];
                if (lower == "roles")
                {
                    if (v == null) continue;
                    if (!(v is string text)) throw new ArgumentException($"{what} は、役割を , で区切った文字にしてください");
                    foreach (var r in text.Split(RoleSeparators).Select(SqlText.Trim).Where(r => r.Length > 0))
                    {
                        if (!output.Roles.Contains(r)) output.Roles.Add(r);
                    }
                    continue;
                }
                CheckAttrName(name, () => what);
                if (row == null) continue;
                // a date or a time is not text, a number or a boolean (as in Node, where it is a Date)
                if (v != null && (columns[i].Type == ColumnType.Date || columns[i].Type == ColumnType.Timestamp)) throw new ArgumentException($"{what} の値は文字・数値・真偽のどれかにしてください");
                output.Attrs[lower] = AttrValue(v, () => what);
            }
            return output;
        }

        /// <summary>Whether <c>a</c> becomes <c>b</c> with at most one letter added, removed, changed, or two side by side swapped.</summary>
        private static bool OneEditAway(string a, string b)
        {
            if (a == b) return true;
            if (Math.Abs(a.Length - b.Length) > 1) return false;
            if (a.Length == b.Length)
            {
                var diff = new List<int>();
                for (var i = 0; i < a.Length; i++)
                {
                    if (a[i] != b[i]) diff.Add(i);
                }
                if (diff.Count == 1) return true;
                return diff.Count == 2 && diff[1] == diff[0] + 1 && a[diff[0]] == b[diff[1]] && a[diff[1]] == b[diff[0]];
            }
            var (longer, shorter) = a.Length > b.Length ? (a, b) : (b, a);
            for (var i = 0; i < longer.Length; i++)
            {
                if (longer.Remove(i, 1) == shorter) return true;
            }
            return false;
        }

        /// <summary>
        /// JavaScript's <c>normalize("NFKC")</c>, which leaves a lone surrogate as it is (.NET's throws): one as U+FFFD,
        /// which reads the same here (only ASCII words are looked for).
        /// </summary>
        private static string Nfkc(string s)
        {
            var b = new StringBuilder(s.Length);
            for (var i = 0; i < s.Length; i++)
            {
                var c = s[i];
                if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
                {
                    b.Append(c).Append(s[++i]);
                }
                else
                {
                    b.Append(char.IsSurrogate(c) ? '�' : c);
                }
            }
            return b.ToString().Normalize(NormalizationForm.FormKC);
        }

        /// <summary>
        /// The <c>-- roles:</c> and <c>-- access:</c> lines among the comment lines at the top of the file (blank lines
        /// between them are fine). So that a rule meant to protect never silently does nothing, these are errors: a word
        /// close to them (<c>-- role:</c>, <c>-- acess:</c>), <c>roles</c> or <c>access</c> without <c>:</c>, an empty
        /// <c>-- roles:</c>, <c>-- access:</c> with anything but <c>all</c>, two of either, and <c>roles:</c> /
        /// <c>access:</c> past the top comments (in the SQL, inside <c>/* */</c>). Throws <see cref="AccessLineException"/>
        /// with <c>&lt;rel&gt;（N 行目）: …</c>.
        /// </summary>
        public static AccessLines Read(string text, string rel)
        {
            List<string>? roles = null;
            string? access = null;
            var rolesLine = 0;
            var accessLine = 0;
            var lines = Dataset.Lines(text);
            for (var i = 0; i < lines.Length; i++)
            {
                var line = lines[i];
                var at = $"{rel}（{i + 1} 行目）";
                if (SqlText.Trim(line).Length > 0 && !CommentLine.IsMatch(line))
                {
                    for (var j = i; j < lines.Length; j++)
                    {
                        var late = LateLine.Match(lines[j]);
                        if (late.Success)
                        {
                            throw new AccessLineException(
                                $"{rel}（{j + 1} 行目）: {late.Groups[1].Value.ToLowerInvariant()}: の行は、ファイルの先頭から続く -- のコメントの中に書いてください（SQL や /* */ の中では読みません。文字として使うなら言い回しを変えてください）");
                        }
                    }
                    break;
                }
                var r = RolesLine.Match(line);
                if (r.Success)
                {
                    if (rolesLine > 0) throw new AccessLineException($"{at}: -- roles: が 2 つあります（{rolesLine} 行目にも）。1 行に , で区切って書きます");
                    rolesLine = i + 1;
                    var names = new List<string>();
                    foreach (var name in r.Groups[1].Value.Split(RoleSeparators).Select(SqlText.Trim).Where(n => n.Length > 0))
                    {
                        if (!names.Contains(name)) names.Add(name);
                    }
                    if (names.Count == 0) throw new AccessLineException($"{at}: -- roles: のあとに、読んでよい役割を , で区切って書いてください（例: -- roles: 経理, CORP\\Managers）");
                    roles = names;
                    continue;
                }
                var a = AccessLine.Match(line);
                if (a.Success)
                {
                    if (accessLine > 0) throw new AccessLineException($"{at}: -- access: が 2 つあります（{accessLine} 行目にも）");
                    accessLine = i + 1;
                    var value = SqlText.Trim(a.Groups[1].Value);
                    if (!(value.Length == 3 && (value[0] | 0x20) == 'a' && (value[1] | 0x20) == 'l' && (value[2] | 0x20) == 'l'))
                    {
                        throw new AccessLineException($"{at}: -- access: に書けるのは all だけです（{(value.Length > 0 ? value : "空")} が書いてあります）");
                    }
                    access = "all";
                    continue;
                }
                // As a person may type it: full-width letters, colon and spaces (NFKC) read as half-width.
                var plain = Nfkc(line);
                if (RolesLine.IsMatch(plain) || AccessLine.IsMatch(plain))
                {
                    var word = RolesLine.IsMatch(plain) ? "roles" : "access";
                    throw new AccessLineException($"{at}: -- {word}: は半角の英字と : で書いてください（このままでは読みません）");
                }
                var w = FirstWord.Match(plain);
                var first = w.Success ? w.Groups[1].Value.ToLowerInvariant() : null;
                // Without the ":" (`-- roles 経理`): a rule that would do nothing. `-- access` alone is a description (`-- Access log`):
                // a missing `-- access: all` only refuses more, so only `-- access all` is taken for one.
                if (w.Success && !w.Groups[2].Success && (first == "roles" || (first == "access" && AccessAll.IsMatch(plain))))
                {
                    var example = first == "roles" ? "-- roles: 経理" : "-- access: all";
                    throw new AccessLineException($"{at}: -- {first} の行は {example} のように : を付けて書きます（説明の文なら、言い回しを変えてください）");
                }
                if (w.Success && w.Groups[2].Success)
                {
                    foreach (var (near, right) in new[] { ("roles", "-- roles:"), ("access", "-- access:") })
                    {
                        if (first!.Length >= 2 && first.Substring(0, 2) == near.Substring(0, 2) && OneEditAway(first, near))
                        {
                            throw new AccessLineException($"{at}: -- {w.Groups[1].Value}: は {right} の書き間違いではありませんか（このままでは読みません。説明の文なら、言い回しを変えてください）");
                        }
                    }
                }
                // `roles:` / `access:` not right after the `--` (`--- roles:`, `-- @roles:`, `-- ※roles:`): not read either.
                var loose = LateLine.Match(plain);
                if (loose.Success)
                {
                    var name = loose.Groups[1].Value.ToLowerInvariant();
                    throw new AccessLineException(
                        $"{at}: {name}: の行は、{(name == "roles" ? "-- roles: 経理" : "-- access: all")} のように -- のすぐあとに書いてください（このままでは読みません。説明の文なら、言い回しを変えてください）");
                }
            }
            return new AccessLines(roles, access);
        }

        /// <summary>Why the project files put it in row-level mode, or null: plain text search, not SQL parsing (any doubt → on).</summary>
        public static string? RowLevelSignal(string text)
        {
            if (UserDot.IsMatch(text)) return ":user.";
            // `roles:` / `access:` in a `--` comment, as Read reads (or refuses) them: full-width as half-width. Not a
            // comment that only mentions the word (`-- Access log`), which would put a project without logins in the mode.
            foreach (var line in AnyLineBreak.Split(text))
            {
                var at = line.IndexOf("--", StringComparison.Ordinal);
                if (at < 0) continue;
                var m = LateLine.Match(Nfkc(line.Substring(at + 2)));
                if (m.Success) return $"-- {m.Groups[1].Value.ToLowerInvariant()}:";
            }
            return null;
        }

        /// <summary>A user id (or anything a user sent) as it may go into one log line: control characters as <c>?</c>.</summary>
        public static string LogSafe(string text)
        {
            var b = new StringBuilder(text.Length);
            foreach (var c in text) b.Append(c <= '\u001f' || (c >= '\u007f' && c <= '\u009f') || c == '\u2028' || c == '\u2029' ? '?' : c);
            return b.ToString();
        }
    }
}
