// The CLIs' output is read by people and by AI: leave out Node's notice that node:sqlite (the SQLite API database)
// is experimental. Other warnings are printed as usual.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
  console.error(`(node) ${w.name}: ${w.message}`);
});
