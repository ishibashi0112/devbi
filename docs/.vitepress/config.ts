// The documentation site (https://ishibashi0112.github.io/devbi/). `pnpm docs:dev` to write, `pnpm docs:build` to build.
// The pages are README.md and docs/*.md themselves (see repo.ts); this file only adds the navigation and the look.
// .github/workflows/pages.yml publishes it with the live demo (examples/oss) under /demo/.
import { defineConfig } from "vitepress";
import { checkLinks, githubSlug, notPages, pages, repoLinks, repoUrl, sections } from "./repo";

// Where GitHub Pages serves the site. DOCS_BASE=/ for a site at the root of a domain.
const base = (process.env.DOCS_BASE ?? "/devbi/").replace(/^\/?/, "/").replace(/\/?$/, "/");
const description = "開発者が自社アプリ・社内システムに組み込む、コードで管理する BI";
const icon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='1' y='8' width='3' height='7' rx='1' fill='%233b6fe0'/%3E%3Crect x='6.5' y='4' width='3' height='11' rx='1' fill='%233b6fe0'/%3E%3Crect x='12' y='1' width='3' height='14' rx='1' fill='%233b6fe0'/%3E%3C/svg%3E";

/** A page in the sidebar, with its level-2 headings under it (folded). */
const headings = await sections();
const page = (text: string, source: string) => {
  const path = pages[source];
  if (!path) throw new Error(`${source} はサイトのページではありません（docs/.vitepress/repo.ts の pages）`);
  return { text, link: `/${path.replace(/\.md$/, "")}`, collapsed: true, items: headings[source] };
};

export default defineConfig({
  lang: "ja-JP",
  title: "DevBI",
  description,
  base,
  srcDir: "..",
  srcExclude: notPages,
  rewrites: pages,
  cleanUrls: true,
  // The pages tell you to open http://localhost:5173 and so on.
  ignoreDeadLinks: "localhostLinks",
  head: [
    ["link", { rel: "icon", href: icon }],
    ["meta", { property: "og:title", content: "DevBI" }],
    ["meta", { property: "og:description", content: description }],
    // The live demo was at the top of the site until the documentation came; its links (…/devbi/#/oss) still work.
    [
      "script",
      {},
      `(function(){var b=${JSON.stringify(base)},p=location.pathname;if(location.hash.indexOf("#/")===0&&(p===b||p===b+"index.html"))location.replace(b+"demo/"+location.hash)})()`,
    ],
  ],
  markdown: {
    // The same anchors as GitHub, so that links like reference.md#エディタでの補完と型pnpm-gen work in both places.
    anchor: { slugify: githubSlug },
    config: (md) => repoLinks(md),
  },
  // A link to a file, page or heading that is not there stops the build.
  buildEnd: checkLinks,
  transformPageData(data) {
    if (data.relativePath === "repository.md") data.title = "リポジトリと開発";
  },
  themeConfig: {
    logo: { src: icon, alt: "" },
    nav: [
      { text: "はじめる", link: "/reference#はじめるcreate-devbi" },
      { text: "リファレンス", link: "/reference" },
      { text: "社内に公開する", link: "/deploying" },
      {
        text: "開発",
        items: [
          { text: "リポジトリと開発", link: "/repository" },
          { text: "動作チェックの手順", link: "/manual-check" },
          { text: "npm への公開", link: "/releasing" },
        ],
      },
      // Not a page of this site: target keeps VitePress's router from looking for it.
      { text: "ライブデモ", link: "/demo/", target: "_self" },
    ],
    sidebar: [
      {
        text: "使う",
        items: [page("リファレンス", "docs/reference.md"), page("社内に公開する", "docs/deploying.md")],
      },
      {
        text: "DevBI の開発",
        items: [
          page("リポジトリと開発", "README.md"),
          page("動作チェックの手順", "docs/manual-check.md"),
          page("npm への公開", "docs/releasing.md"),
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: repoUrl },
      { icon: "npm", link: "https://www.npmjs.com/package/devbi" },
    ],
    editLink: { pattern: `${repoUrl}/edit/main/:path`, text: "このページを GitHub で直す" },
    footer: { message: "MIT ライセンス", copyright: "© ishibashi0112" },
    outline: { level: [2, 3], label: "このページの内容" },
    docFooter: { prev: "前のページ", next: "次のページ" },
    darkModeSwitchLabel: "外観",
    lightModeSwitchTitle: "ライトにする",
    darkModeSwitchTitle: "ダークにする",
    sidebarMenuLabel: "メニュー",
    returnToTopLabel: "上に戻る",
    skipToContentLabel: "本文へ",
    notFound: {
      title: "ページが見つかりません",
      quote: "アドレスが変わったか、ページがなくなりました。",
      linkLabel: "トップへ",
      linkText: "トップへ",
    },
    search: {
      provider: "local",
      options: {
        translations: {
          button: { buttonText: "検索", buttonAriaLabel: "検索" },
          modal: {
            displayDetails: "前後も出す",
            resetButtonTitle: "消す",
            backButtonTitle: "閉じる",
            noResultsText: "見つかりません",
            footer: { selectText: "開く", navigateText: "選ぶ", closeText: "閉じる" },
          },
        },
        miniSearch: {
          // Japanese has no spaces between words: split with the browser's (and Node's) word segmenter. The function
          // is sent to the browser as text, so it uses nothing from outside itself.
          options: {
            tokenize(text: string) {
              if (typeof Intl === "undefined" || !("Segmenter" in Intl)) return text.split(/[\s\p{P}\p{S}]+/u);
              const words: string[] = [];
              for (const s of new Intl.Segmenter("ja", { granularity: "word" }).segment(text)) {
                if (s.isWordLike) words.push(s.segment);
              }
              return words;
            },
          },
        },
      },
    },
  },
});
