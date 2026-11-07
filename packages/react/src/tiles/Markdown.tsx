import { hasUrlScheme, type TileProps } from "devbi";
import { Fragment, type ReactNode } from "react";

function safeHref(href: string): string | undefined {
  // Browsers drop control characters, so "\u0001javascript:" would become a script URL: refuse those outright.
  if (/[\u0000-\u001f\u007f]/.test(href)) return undefined;
  return /^(https?:|mailto:|#|\.{0,2}\/)/i.test(href) || !hasUrlScheme(href) ? href : undefined;
}

/** Inline markdown: **bold**, *italic*, `code`, [links](url). Text is never parsed as HTML. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={k++}>{inline(m[1])}</strong>);
    else if (m[2] !== undefined) out.push(<em key={k++}>{inline(m[2])}</em>);
    else if (m[3] !== undefined) out.push(<code key={k++}>{m[3]}</code>);
    else {
      const href = safeHref(m[5]!);
      out.push(
        href ? (
          <a key={k++} href={href} target={/^https?:/.test(href) ? "_blank" : undefined} rel="noreferrer">
            {inline(m[4]!)}
          </a>
        ) : (
          <Fragment key={k++}>{m[4]}</Fragment>
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Block markdown: headings, paragraphs, bullet and numbered lists, horizontal rules. */
export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let k = 0;
  const flush = () => {
    if (para.length) blocks.push(<p key={k++}>{inline(para.join(" "))}</p>);
    para = [];
    if (list) {
      const items = list.items.map((it, i) => <li key={i}>{inline(it)}</li>);
      blocks.push(list.ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
    }
    list = null;
  };
  for (const line of lines) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flush();
    } else if (h) {
      flush();
      const level = h[1]!.length;
      const content = inline(h[2]!);
      blocks.push(
        level === 1 ? <h2 key={k++}>{content}</h2> : level === 2 ? <h3 key={k++}>{content}</h3> : <h4 key={k++}>{content}</h4>,
      );
    } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flush();
      blocks.push(<hr key={k++} />);
    } else if (li) {
      if (para.length) flush();
      const ordered = /\d/.test(li[1]!);
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push(li[2]!);
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/** A text tile. `options.text` holds the markdown. */
export function Markdown({ tile }: TileProps) {
  const text = typeof tile.options?.text === "string" ? tile.options.text : "";
  return <div className="devbi-markdown">{renderMarkdown(text)}</div>;
}
