// Reading SQL Server text without running it: where quotes and comments are, whether a statement only reads, and
// its :name parameters. A port of packages/server/src/sqltext.ts with SQL Server's rules ([brackets], no
// backslash escapes); the same cases are checked against both (packages/server/test/fixtures/sqlserver-cases.json).
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace DevBI.Server
{
    /// <summary>One statement of a SQL file.</summary>
    public sealed class SqlStatement
    {
        public SqlStatement(string sql, string title, int line)
        {
            Sql = sql;
            Title = title;
            Line = line;
        }

        /// <summary>The statement as it is sent: without the comments above it and without its terminator.</summary>
        public string Sql { get; }

        /// <summary>The comment lines right above it, without <c>--</c> / <c>/* */</c>.</summary>
        public string Title { get; }

        /// <summary>Line in the file where the statement starts (1-based).</summary>
        public int Line { get; }
    }

    /// <summary>Why a statement is not run: <c>not-select</c>, <c>several</c>, <c>writes</c>, <c>locks</c> or <c>sequence</c>.</summary>
    public sealed class SqlProblem
    {
        public SqlProblem(string code, string? word)
        {
            Code = code;
            Word = word;
        }

        public string Code { get; }

        /// <summary>The statement's first word (not-select), or the word that writes or locks.</summary>
        public string? Word { get; }
    }

    /// <summary>A <c>:name</c> parameter in the SQL text.</summary>
    public sealed class SqlParameterPlace
    {
        public SqlParameterPlace(string name, int start, int end)
        {
            Name = name;
            Start = start;
            End = end;
        }

        public string Name { get; }
        public int Start { get; }
        public int End { get; }
    }

    public static class SqlText
    {
        /// <summary>The characters JavaScript's <c>\s</c> matches (so both versions read the same text the same way).</summary>
        internal const string Space = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

        internal static bool IsSpace(char c) =>
            c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r' || c == ' ' || c == '\u00a0' || c == '\u1680' ||
            (c >= '\u2000' && c <= '\u200a') || c == '\u2028' || c == '\u2029' || c == '\u202f' || c == '\u205f' || c == '\u3000' || c == '\ufeff';

        /// <summary>JavaScript's <c>trim()</c>.</summary>
        internal static string Trim(string s)
        {
            int start = 0, end = s.Length;
            while (start < end && IsSpace(s[start])) start++;
            while (end > start && IsSpace(s[end - 1])) end--;
            return s.Substring(start, end - start);
        }

        private static readonly Regex Separator = new Regex($"^[{Space}]*(go([{Space}]+[0-9]+)?|/)[{Space}]*\\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        /// <summary>
        /// Statements end at a <c>;</c>, at a line holding only <c>GO</c> (SQL Server's tools) or only <c>/</c>, outside quotes and comments.
        /// </summary>
        public static List<SqlStatement> SplitStatements(string text)
        {
            var output = new List<SqlStatement>();
            var src = (text.Length > 0 && text[0] == '\ufeff' ? text.Substring(1) : text).Replace("\r\n", "\n").Replace('\r', '\n');
            var comments = new List<string>();
            int start = -1, line = 1, startLine = 1;
            bool lineHasContent = false;

            void Finish(int end)
            {
                if (start >= 0)
                {
                    var sql = Trim(src.Substring(start, end - start));
                    if (sql.Length > 0) output.Add(new SqlStatement(sql, Trim(string.Join("\n", comments)), startLine));
                }
                comments = new List<string>();
                start = -1;
            }

            // The end of the line starting at i when it holds only GO (optionally a count) or only "/", otherwise -1.
            int SeparatorEnd(int i)
            {
                var nl = src.IndexOf('\n', i);
                var end = nl < 0 ? src.Length : nl;
                return Separator.IsMatch(src.Substring(i, end - i)) ? end : -1;
            }

            int i = 0;
            bool atLineStart = true;
            while (i < src.Length)
            {
                var c = src[i];
                if (atLineStart)
                {
                    atLineStart = false;
                    var end = SeparatorEnd(i);
                    if (end >= 0)
                    {
                        Finish(i);
                        i = end;
                        continue;
                    }
                }
                if (c == '\n')
                {
                    // a blank line between comments and a statement: those comments are not its title
                    if (!lineHasContent && start < 0) comments = new List<string>();
                    line++;
                    atLineStart = true;
                    lineHasContent = false;
                    i++;
                    continue;
                }
                if (IsSpace(c))
                {
                    i++;
                    continue;
                }
                lineHasContent = true;
                var comment = CommentEnd(src, i);
                if (comment > i)
                {
                    var bodyStart = i + 2;
                    var bodyEnd = src[i + 1] == '*' && comment - 2 >= 0 && string.CompareOrdinal(src, comment - 2, "*/", 0, 2) == 0 ? comment - 2 : comment;
                    var body = bodyEnd > bodyStart ? src.Substring(bodyStart, bodyEnd - bodyStart) : "";
                    // comments before the statement's first word are its title; inside it, they stay part of it
                    if (start < 0) comments.AddRange(body.Split('\n').Select(l => Trim(StripCommentLead(l))));
                    line += body.Count(ch => ch == '\n');
                    i = comment;
                    continue;
                }
                if (c == ';')
                {
                    Finish(i);
                    i++;
                    continue;
                }
                if (start < 0)
                {
                    start = i;
                    startLine = line;
                }
                var close = QuoteEnd(src, i);
                if (close > i)
                {
                    line += src.Substring(i, close - i).Count(ch => ch == '\n');
                    i = close;
                    continue;
                }
                i++;
            }
            Finish(src.Length);
            return output;
        }

        /// <summary>JavaScript's <c>l.replace(/^\s*\*?\s?/, "")</c>: the spaces and the <c>*</c> that start a line of a block comment.</summary>
        private static string StripCommentLead(string l)
        {
            int k = 0;
            while (k < l.Length && IsSpace(l[k])) k++;
            if (k < l.Length && l[k] == '*') k++;
            if (k < l.Length && IsSpace(l[k])) k++;
            return l.Substring(k);
        }

        /// <summary>When a comment starts at i: the index after it ends (or the end of the text). Otherwise i.</summary>
        private static int CommentEnd(string src, int i)
        {
            if (i + 1 < src.Length && src[i] == '-' && src[i + 1] == '-')
            {
                var end = src.IndexOf('\n', i);
                return end < 0 ? src.Length : end;
            }
            if (i + 1 < src.Length && src[i] == '/' && src[i + 1] == '*')
            {
                var end = src.IndexOf("*/", i + 2, StringComparison.Ordinal);
                return end < 0 ? src.Length : end + 2;
            }
            return i;
        }

        /// <summary>Letters, digits and _ $ # @ continue a name, and so do non-ASCII characters other than spaces (受注番号).</summary>
        private static bool IsNameChar(string s, int i)
        {
            if (i < 0 || i >= s.Length) return false;
            var c = s[i];
            return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '$' || c == '#' || c == '@' || (c > '\x7f' && !IsSpace(c));
        }

        /// <summary>When a quote starts at i ('…', "…", `…`, […]): the index after it ends (or the end of the text). Otherwise i.</summary>
        private static int QuoteEnd(string src, int i)
        {
            var c = src[i];
            if (c != '\'' && c != '"' && c != '`' && c != '[') return i;
            var end = c == '[' ? ']' : c;
            var j = i + 1;
            while (j < src.Length)
            {
                if (src[j] == end)
                {
                    // a doubled quote is an escaped quote
                    if (j + 1 < src.Length && src[j + 1] == end)
                    {
                        j += 2;
                        continue;
                    }
                    return j + 1;
                }
                j++;
            }
            return src.Length;
        }

        private static readonly Regex AfterDot = new Regex($"\\.[{Space}]*\\z", RegexOptions.CultureInvariant);

        /// <summary>The statement's words outside quotes and comments, in upper case, in order, and whether a <c>;</c> is among them.</summary>
        private static List<string> Scan(string sql, out bool semicolon)
        {
            var words = new List<string>();
            semicolon = false;
            int i = 0;
            while (i < sql.Length)
            {
                var comment = CommentEnd(sql, i);
                if (comment > i)
                {
                    i = comment;
                    continue;
                }
                var close = QuoteEnd(sql, i);
                if (close > i)
                {
                    i = close;
                    continue;
                }
                if (sql[i] == ';') semicolon = true;
                var length = WordLength(sql, i);
                if (length > 0 && !IsNameChar(sql, i - 1))
                {
                    var upper = sql.Substring(i, length).ToUpperInvariant();
                    var before = Math.Max(0, i - 8);
                    // a name right after a dot is a column or table name (o.update_date), not a keyword; seq.NEXTVAL still counts
                    if (!AfterDot.IsMatch(sql.Substring(before, i - before)) || upper == "NEXTVAL") words.Add(upper);
                    i += length;
                    continue;
                }
                i++;
            }
            return words;
        }

        /// <summary>JavaScript's <c>/^[A-Za-z_][A-Za-z0-9_$#@]*/</c> on the next 256 characters: the length of the word at i, or 0.</summary>
        private static int WordLength(string s, int i)
        {
            bool Ascii(char c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
            if (!(Ascii(s[i]) || s[i] == '_')) return 0;
            var limit = Math.Min(s.Length, i + 256);
            var j = i + 1;
            while (j < limit && (Ascii(s[j]) || (s[j] >= '0' && s[j] <= '9') || s[j] == '_' || s[j] == '$' || s[j] == '#' || s[j] == '@')) j++;
            return j - i;
        }

        /// <summary>Words that write, lock, run code, or reach outside the database.</summary>
        private static readonly HashSet<string> Refused = new HashSet<string>(StringComparer.Ordinal)
        {
            "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "TRUNCATE", "CREATE", "ALTER", "DROP", "RENAME",
            "GRANT", "REVOKE", "DENY", "EXEC", "EXECUTE", "CALL", "INTO", "DECLARE", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT",
            "FUNCTION", "PROCEDURE", "PRAGMA", "LOCK", "UNLOCK", "USE", "SET", "SETUSER", "SHUTDOWN", "KILL", "RECONFIGURE",
            "BACKUP", "RESTORE", "DUMP", "DBCC", "VACUUM", "ATTACH", "DETACH", "WRITETEXT", "UPDATETEXT", "SEND", "RECEIVE",
            "CONVERSATION", "NEXTVAL", "SETVAL", "OPENROWSET", "OPENDATASOURCE", "OPENQUERY", "OPENXML",
            // SQL Server's table hints that hold locks until the transaction ends
            "UPDLOCK", "XLOCK", "HOLDLOCK", "TABLOCKX",
        };

        /// <summary>
        /// Why the statement may not run, or null when it only reads: it must start with SELECT or WITH and contain none of
        /// the words that write (INSERT, UPDATE, SELECT … INTO, FOR UPDATE …). Strict on purpose: a column named like one of
        /// those words must be quoted. The database user should still be granted SELECT only: this is the first guard, not the last.
        /// </summary>
        public static SqlProblem? ReadOnlyProblem(string sql)
        {
            var w = Scan(sql, out var semicolon);
            var first = w.Count > 0 ? w[0] : null;
            if (first != "SELECT" && first != "WITH") return new SqlProblem("not-select", first);
            // a ; left after splitting means the database may read a second statement where the split saw a quote
            if (semicolon) return new SqlProblem("several", null);
            for (int i = 0; i < w.Count; i++)
            {
                var word = w[i];
                var next = i + 1 < w.Count ? w[i + 1] : null;
                if (Refused.Contains(word)) return new SqlProblem("writes", word);
                // FOR SHARE / FOR KEY SHARE / FOR NO KEY UPDATE lock rows (FOR UPDATE is refused above)
                if (word == "FOR" && (next == "SHARE" || next == "KEY" || next == "NO")) return new SqlProblem("locks", "FOR " + next);
                if (word == "NEXT" && next == "VALUE") return new SqlProblem("sequence", "NEXT VALUE FOR");
            }
            return null;
        }

        /// <summary>
        /// The <c>:name</c> parameters outside quotes and comments, in order (a name may appear more than once). Not
        /// <c>::</c> (<c>geography::Point</c>), not <c>:=</c>, and not a colon right after a name.
        /// </summary>
        public static List<SqlParameterPlace> Parameters(string sql)
        {
            var output = new List<SqlParameterPlace>();
            int i = 0;
            while (i < sql.Length)
            {
                var comment = CommentEnd(sql, i);
                if (comment > i)
                {
                    i = comment;
                    continue;
                }
                var close = QuoteEnd(sql, i);
                if (close > i)
                {
                    i = close;
                    continue;
                }
                if (sql[i] == ':')
                {
                    if ((i + 1 < sql.Length && sql[i + 1] == ':') || (i > 0 && sql[i - 1] == ':'))
                    {
                        i += 2;
                        continue;
                    }
                    var length = ParameterNameLength(sql, i + 1);
                    if (length > 0 && !IsNameChar(sql, i - 1))
                    {
                        output.Add(new SqlParameterPlace(sql.Substring(i + 1, length), i, i + 1 + length));
                        i += 1 + length;
                        continue;
                    }
                }
                i++;
            }
            return output;
        }

        /// <summary>JavaScript's <c>/^[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*/</c> on the next 128 characters.</summary>
        private static int ParameterNameLength(string s, int i)
        {
            bool Letter(char c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || c >= '\u0080';
            if (i >= s.Length || !Letter(s[i])) return 0;
            var limit = Math.Min(s.Length, i + 128);
            var j = i + 1;
            while (j < limit && (Letter(s[j]) || (s[j] >= '0' && s[j] <= '9'))) j++;
            return j - i;
        }
    }
}
