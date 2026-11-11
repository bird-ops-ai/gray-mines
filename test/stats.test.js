"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");

function loadGame() {
  const start = html.indexOf("/**\n * Gray Mines — core rules");
  const scriptStart = html.lastIndexOf("<script>", start);
  const scriptEnd = html.indexOf("</script>", start);
  assert.ok(scriptStart !== -1 && scriptEnd !== -1, "core script found");
  const code = html.slice(scriptStart + "<script>".length, scriptEnd);
  const sandbox = { console };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: "index.html" });
  return sandbox.module.exports;
}

function memoryStorage(initial) {
  const map = Object.assign({}, initial || {});
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
    },
    setItem(key, value) {
      map[key] = String(value);
    },
    removeItem(key) {
      delete map[key];
    },
    dump() {
      return Object.assign({}, map);
    },
  };
}

const G = loadGame();

function test(name, fn) {
  try {
    fn();
    console.log("ok  " + name);
  } catch (err) {
    console.error("FAIL " + name);
    throw err;
  }
}

test("page exposes a Stats button and the worker cache moved to v2", () => {
  assert.ok(html.includes('id="stats-btn"'));
  assert.ok(html.includes(">Stats<"));
  assert.ok(sw.includes('const CACHE = "gray-mines-v2"'));
  assert.ok(sw.includes("skipWaiting"));
  assert.ok(sw.includes("clients.claim"));
  assert.ok(html.includes('updateViaCache: "none"'));
});

test("migrates legacy best times without inventing games", () => {
  const store = memoryStorage({
    "graymines-best": JSON.stringify({ easy: 42, medium: 125, hard: null }),
  });
  const stats = G.loadStats(store);
  assert.strictEqual(stats.easy.best, 42);
  assert.strictEqual(stats.medium.best, 125);
  assert.strictEqual(stats.hard.best, null);
  assert.strictEqual(stats.easy.played, 0);
  assert.strictEqual(stats.easy.won, 0);
  assert.strictEqual(stats.easy.streak, 0);
  const bests = G.loadBests(store);
  assert.strictEqual(bests.easy, 42);
  assert.strictEqual(bests.medium, 125);
  assert.strictEqual(bests.hard, null);
  const summary = G.summarize(stats.easy);
  assert.strictEqual(summary.winPct, null);
  assert.strictEqual(summary.avgWin, null);
  assert.strictEqual(summary.best, 42);
});

test("keeps the faster best when stats and legacy disagree", () => {
  const store = memoryStorage({
    "graymines-best": JSON.stringify({ easy: 30, medium: 90 }),
    "graymines-stats": JSON.stringify({
      easy: { played: 4, won: 2, best: 50, winTimeSum: 80, streak: 1, bestStreak: 2 },
      medium: { played: 1, won: 1, best: 40, winTimeSum: 40, streak: 1, bestStreak: 1 },
    }),
  });
  const stats = G.loadStats(store);
  assert.strictEqual(stats.easy.best, 30);
  assert.strictEqual(stats.easy.played, 4);
  assert.strictEqual(stats.easy.won, 2);
  assert.strictEqual(stats.medium.best, 40);
  assert.strictEqual(G.summarize(stats.easy).winPct, 50);
  assert.strictEqual(G.summarize(stats.easy).avgWin, 40);
});

test("corrupt stats fall back to legacy bests", () => {
  const store = memoryStorage({
    "graymines-best": JSON.stringify({ hard: 200 }),
    "graymines-stats": "{",
  });
  const stats = G.loadStats(store);
  assert.strictEqual(stats.hard.best, 200);
  assert.strictEqual(stats.hard.played, 0);
  assert.strictEqual(stats.easy.played, 0);
});

test("wins update streak, best, average, and leave other difficulties alone", () => {
  const store = memoryStorage({
    "graymines-best": JSON.stringify({ easy: 15 }),
  });
  const slower = G.recordResult(store, "easy", { won: true, seconds: 20 });
  assert.strictEqual(slower.record, false);
  assert.strictEqual(slower.streak, 1);
  assert.strictEqual(slower.summary.best, 15);
  assert.strictEqual(slower.summary.played, 1);
  assert.strictEqual(slower.summary.won, 1);
  assert.strictEqual(slower.summary.avgWin, 20);

  const faster = G.recordResult(store, "easy", { won: true, seconds: 10 });
  assert.strictEqual(faster.record, true);
  assert.strictEqual(faster.streak, 2);
  assert.strictEqual(faster.bestStreak, 2);
  assert.strictEqual(faster.summary.best, 10);
  assert.strictEqual(faster.summary.avgWin, 15);
  assert.strictEqual(faster.summary.winPct, 100);
  assert.strictEqual(G.loadStats(store).medium.played, 0);
});

test("a loss or abandon breaks the streak and does not change best or average", () => {
  const store = memoryStorage();
  G.recordResult(store, "medium", { won: true, seconds: 30 });
  G.recordResult(store, "medium", { won: true, seconds: 50 });
  const loss = G.recordResult(store, "medium", { won: false, seconds: 5 });
  assert.strictEqual(loss.endedStreak, true);
  assert.strictEqual(loss.streak, 0);
  assert.strictEqual(loss.bestStreak, 2);
  assert.strictEqual(loss.summary.best, 30);
  assert.strictEqual(loss.summary.avgWin, 40);
  assert.strictEqual(loss.summary.played, 3);
  assert.strictEqual(loss.summary.won, 2);
  assert.strictEqual(loss.summary.winPct, 67);

  const again = G.recordResult(store, "medium", { won: true, seconds: 10 });
  assert.strictEqual(again.record, true);
  assert.strictEqual(again.streak, 1);
  assert.strictEqual(again.bestStreak, 2);
  const cold = G.recordResult(store, "medium", { won: false, seconds: 8 });
  assert.strictEqual(cold.endedStreak, true);
  const quiet = G.recordResult(store, "medium", { won: false, seconds: 8 });
  assert.strictEqual(quiet.endedStreak, false);
  assert.strictEqual(quiet.streak, 0);
});

test("an untouched or flag-only board is not a game; a started board abandoned on switch is a loss", () => {
  const store = memoryStorage();
  const ready = G.createGame("hard");
  assert.strictEqual(ready.status, "ready");
  assert.strictEqual(G.leaveOutcome(ready), null);
  G.toggleFlag(ready, 0, 0);
  assert.strictEqual(ready.status, "ready");
  assert.strictEqual(G.leaveOutcome(ready), null);

  const started = G.createGame("easy", { mines: [[0, 0]] });
  const first = G.reveal(started, 1, 1);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(started.status, "playing");
  assert.ok(started.revealedCount > 0);
  const outcome = G.leaveOutcome(started);
  assert.strictEqual(outcome.won, false);
  assert.strictEqual(typeof outcome.seconds, "number");

  let difficulty = "easy";
  G.recordResult(store, difficulty, outcome);
  difficulty = "hard";
  assert.strictEqual(G.loadStats(store).easy.played, 1);
  assert.strictEqual(G.loadStats(store).easy.won, 0);
  assert.strictEqual(G.loadStats(store).easy.streak, 0);
  assert.strictEqual(G.loadStats(store).hard.played, 0);
  assert.strictEqual(difficulty, "hard");
});

test("finishing a game is not also an abandon", () => {
  const won = G.createGame({ id: "easy", rows: 2, cols: 2, mines: 1 }, { mines: [[0, 0]] });
  G.reveal(won, 0, 1);
  G.reveal(won, 1, 0);
  G.reveal(won, 1, 1);
  assert.strictEqual(won.status, "won");
  assert.strictEqual(G.leaveOutcome(won), null);

  const lost = G.createGame("easy", { mines: [[0, 0]] });
  const hit = G.reveal(lost, 0, 0);
  assert.strictEqual(hit.hitMine, true);
  assert.strictEqual(lost.status, "lost");
  assert.strictEqual(G.leaveOutcome(lost), null);
});

test("all overview sums games and averages wins, without a cross-difficulty best or streak", () => {
  const store = memoryStorage();
  G.recordResult(store, "easy", { won: true, seconds: 10 });
  G.recordResult(store, "easy", { won: false, seconds: 4 });
  G.recordResult(store, "hard", { won: true, seconds: 100 });
  G.recordResult(store, "hard", { won: true, seconds: 80 });
  const all = G.summarizeAll(G.loadStats(store));
  assert.strictEqual(all.played, 4);
  assert.strictEqual(all.won, 3);
  assert.strictEqual(all.winPct, 75);
  assert.strictEqual(all.avgWin, 63);
  assert.strictEqual(all.best, null);
  assert.strictEqual(all.streak, null);
  assert.strictEqual(all.bestStreak, 2);
});

test("reset clears stats and legacy bests so they are not migrated back", () => {
  const store = memoryStorage({
    "graymines-best": JSON.stringify({ easy: 9, medium: 40, hard: 100 }),
  });
  G.loadStats(store);
  G.recordResult(store, "easy", { won: true, seconds: 12 });
  G.resetStats(store);
  const stats = G.loadStats(store);
  assert.strictEqual(stats.easy.played, 0);
  assert.strictEqual(stats.easy.best, null);
  assert.strictEqual(stats.medium.best, null);
  assert.strictEqual(stats.hard.best, null);
  assert.deepStrictEqual(JSON.parse(store.getItem("graymines-best")), {
    easy: null,
    medium: null,
    hard: null,
  });
});

console.log("all stats tests passed");
