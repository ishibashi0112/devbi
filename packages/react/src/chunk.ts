/**
 * Load a part of DevBI that comes as its own file (the charts, the DuckDB engine). When the file cannot be
 * fetched (most often: the site was rebuilt while the page was open, so the old file is gone), the browser
 * keeps that failure until the page is reloaded, so say that in Japanese instead of the browser's message.
 */
export async function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (e) {
    throw new Error("画面のファイルを読み込めませんでした。サイトが更新された可能性があります。ページを読み込み直してください。", {
      cause: e,
    });
  }
}
