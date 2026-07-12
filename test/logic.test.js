"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  pick,
  roundOrNull,
  startOfDay,
  classifyEvent,
  nowMinutes,
  parseHHMM,
  normalizeSchedule,
  currentSegmentIndex,
  clampLevel,
  computeBrightness,
} = require("../lib/logic");

// ---------------------------------------------------------------------------
// 汎用ヘルパー
// ---------------------------------------------------------------------------

test("roundOrNull は数値を丸め、非数は null", () => {
  assert.equal(roundOrNull(20.4), 20);
  assert.equal(roundOrNull(20.6), 21);
  assert.equal(roundOrNull(null), null);
  assert.equal(roundOrNull(undefined), null);
  assert.equal(roundOrNull(NaN), null);
});

test("pick は配列以外で undefined", () => {
  assert.equal(pick([1, 2, 3], 1), 2);
  assert.equal(pick(undefined, 0), undefined);
});

test("parseHHMM は分換算", () => {
  assert.equal(parseHHMM("00:00"), 0);
  assert.equal(parseHHMM("06:30"), 390);
  assert.equal(parseHHMM("23:59"), 1439);
});

// ---------------------------------------------------------------------------
// カレンダー仕分け（DESIGN.md §6.4）
// ---------------------------------------------------------------------------

function makeCtx() {
  const todayStart = startOfDay(new Date("2026-06-25T10:00:00"));
  const tomorrowStart = new Date(todayStart.getTime() + 86400000);
  return {
    todayStart,
    tomorrowStart,
    keywords: ["在宅", "出社", "remote"],
  };
}

function emptyBuf() {
  return { today: [], tomorrow: [], allDay: [], location: { today: null, tomorrow: null } };
}

test("時刻つき予定（今日）は today に HH:MM で入る", () => {
  const buf = emptyBuf();
  classifyEvent(
    { summary: "朝会", start: { dateTime: "2026-06-25T09:30:00" } },
    { label: "メイン", role: "events" },
    buf,
    makeCtx()
  );
  assert.deepEqual(buf.today, [{ t: "09:30", title: "朝会", calendar: "メイン" }]);
  assert.equal(buf.tomorrow.length, 0);
});

test("終了時刻があれば end (HH:MM) を付与、無ければ付けない", () => {
  const withEnd = emptyBuf();
  classifyEvent(
    {
      summary: "会議",
      start: { dateTime: "2026-06-25T09:30:00" },
      end: { dateTime: "2026-06-25T10:15:00" },
    },
    { label: "メイン", role: "events" },
    withEnd,
    makeCtx()
  );
  assert.deepEqual(withEnd.today[0], {
    t: "09:30",
    end: "10:15",
    title: "会議",
    calendar: "メイン",
  });

  const noEnd = emptyBuf();
  classifyEvent(
    { summary: "会議", start: { dateTime: "2026-06-25T09:30:00" } },
    { label: "メイン", role: "events" },
    noEnd,
    makeCtx()
  );
  assert.equal("end" in noEnd.today[0], false);
});

test("時刻つき予定（明日）は tomorrow に入る", () => {
  const buf = emptyBuf();
  classifyEvent(
    { summary: "顧客MTG", start: { dateTime: "2026-06-26T14:00:00" } },
    { label: "仕事", role: "events" },
    buf,
    makeCtx()
  );
  assert.equal(buf.today.length, 0);
  assert.equal(buf.tomorrow[0].t, "14:00");
});

test("role:location の終日予定は location へ", () => {
  const buf = emptyBuf();
  classifyEvent(
    { summary: "本社", start: { date: "2026-06-25" } },
    { label: "勤務場所", role: "location" },
    buf,
    makeCtx()
  );
  assert.equal(buf.location.today, "本社");
  assert.equal(buf.allDay.length, 0);
});

test("キーワード一致の終日予定は location へ（events カレンダーでも）", () => {
  const buf = emptyBuf();
  classifyEvent(
    { summary: "在宅勤務", start: { date: "2026-06-26" } },
    { label: "メイン", role: "events" },
    buf,
    makeCtx()
  );
  assert.equal(buf.location.tomorrow, "在宅勤務");
});

test("終日の通常予定は当日のみ allDay、翌日は出さない", () => {
  const today = emptyBuf();
  classifyEvent(
    { summary: "請求書の締め", start: { date: "2026-06-25" } },
    { label: "メイン", role: "events" },
    today,
    makeCtx()
  );
  assert.deepEqual(today.allDay, [{ label: "請求書の締め", calendar: "メイン" }]);

  const tomorrow = emptyBuf();
  classifyEvent(
    { summary: "翌日の終日", start: { date: "2026-06-26" } },
    { label: "メイン", role: "events" },
    tomorrow,
    makeCtx()
  );
  assert.equal(tomorrow.allDay.length, 0);
});

test("範囲外（明後日）の予定はスキップ", () => {
  const buf = emptyBuf();
  classifyEvent(
    { summary: "未来の予定", start: { dateTime: "2026-06-27T09:00:00" } },
    { label: "メイン", role: "events" },
    buf,
    makeCtx()
  );
  assert.equal(buf.today.length + buf.tomorrow.length + buf.allDay.length, 0);
});

test("無題イベントは (無題) になる", () => {
  const buf = emptyBuf();
  classifyEvent(
    { start: { dateTime: "2026-06-25T12:00:00" } },
    { label: "メイン", role: "events" },
    buf,
    makeCtx()
  );
  assert.equal(buf.today[0].title, "(無題)");
});

// ---------------------------------------------------------------------------
// 明るさ・表示モードのスケジュール（DESIGN.md §6.8）
// ---------------------------------------------------------------------------

const SCHEDULE = [
  { from: "06:00", level: 100 },
  { from: "20:00", level: 50 },
  { from: "23:00", level: 15 },
];

test("normalizeSchedule は時刻順に整列し不正値を除外", () => {
  const e = normalizeSchedule(
    [
      { from: "23:00", level: 15 },
      { from: "06:00", level: 100 },
      { from: "bad", level: 1 },
      { from: "20:00", level: null },
    ],
    "level"
  );
  assert.deepEqual(e.map((x) => x.from), [360, 1380]);
});

test("currentSegmentIndex は区間を判定し、先頭より前は末尾区間（巡回）", () => {
  const e = normalizeSchedule(SCHEDULE, "level");
  assert.equal(currentSegmentIndex(e, parseHHMM("06:30")), 0); // 06:00区間
  assert.equal(currentSegmentIndex(e, parseHHMM("21:00")), 1); // 20:00区間
  assert.equal(currentSegmentIndex(e, parseHHMM("23:30")), 2); // 23:00区間
  assert.equal(currentSegmentIndex(e, parseHHMM("02:00")), 2); // 06:00より前 → 前日23:00区間
});

test("clampLevel は 0〜100 に丸めて収める", () => {
  assert.equal(clampLevel(-10), 0);
  assert.equal(clampLevel(150), 100);
  assert.equal(clampLevel(49.6), 50);
});

test("computeBrightness は transition=0 でステップ切替", () => {
  const e = normalizeSchedule(SCHEDULE, "level");
  assert.equal(computeBrightness(e, parseHHMM("12:00"), 0), 100);
  assert.equal(computeBrightness(e, parseHHMM("21:00"), 0), 50);
  assert.equal(computeBrightness(e, parseHHMM("23:30"), 0), 15);
  assert.equal(computeBrightness(e, parseHHMM("03:00"), 0), 15); // 巡回
});

test("computeBrightness は境界中点でちょうど中間値（線形補間）", () => {
  const e = normalizeSchedule(SCHEDULE, "level");
  // 20:00 境界、transition=30分 → 窓は19:45〜20:15、中点20:00で (100+50)/2=75
  assert.equal(computeBrightness(e, parseHHMM("20:00"), 30), 75);
  // 窓の手前（19:45）は before=100、奥（20:15）は after=50
  assert.equal(computeBrightness(e, parseHHMM("19:45"), 30), 100);
  assert.equal(computeBrightness(e, parseHHMM("20:15"), 30), 50);
});

test("computeBrightness は窓の外ではその区間値", () => {
  const e = normalizeSchedule(SCHEDULE, "level");
  assert.equal(computeBrightness(e, parseHHMM("10:00"), 30), 100);
  assert.equal(computeBrightness(e, parseHHMM("21:30"), 30), 50);
});

test("normalizeSchedule は view(mode) も扱える", () => {
  const e = normalizeSchedule(
    [
      { from: "23:00", mode: "night" },
      { from: "06:00", mode: "full" },
    ],
    "mode"
  );
  assert.equal(e[currentSegmentIndex(e, parseHHMM("08:00"))].value, "full");
  assert.equal(e[currentSegmentIndex(e, parseHHMM("23:30"))].value, "night");
  assert.equal(e[currentSegmentIndex(e, parseHHMM("02:00"))].value, "night"); // 巡回
});

test("withinWindow は通常帯と深夜跨ぎを判定", () => {
  const { withinWindow } = require("../lib/logic");
  // 通常帯 09:00-17:00
  assert.equal(withinWindow(parseHHMM("12:00"), parseHHMM("09:00"), parseHHMM("17:00")), true);
  assert.equal(withinWindow(parseHHMM("08:00"), parseHHMM("09:00"), parseHHMM("17:00")), false);
  // 深夜跨ぎ 23:00-06:00
  assert.equal(withinWindow(parseHHMM("23:30"), parseHHMM("23:00"), parseHHMM("06:00")), true);
  assert.equal(withinWindow(parseHHMM("02:00"), parseHHMM("23:00"), parseHHMM("06:00")), true);
  assert.equal(withinWindow(parseHHMM("06:00"), parseHHMM("23:00"), parseHHMM("06:00")), false);
  assert.equal(withinWindow(parseHHMM("12:00"), parseHHMM("23:00"), parseHHMM("06:00")), false);
});

test("nowMinutes は時刻を分換算", () => {
  assert.equal(nowMinutes(new Date("2026-06-25T06:30:00")), 390);
});

// ---------------------------------------------------------------------------
// 株価（Yahoo Finance chart API）
// ---------------------------------------------------------------------------

test("parseYahooQuote は現在値と前日比%を返す", () => {
  const { parseYahooQuote } = require("../lib/logic");
  const r = parseYahooQuote({
    regularMarketPrice: 2823,
    chartPreviousClose: 2923,
  });
  assert.equal(r.price, 2823);
  assert.equal(r.chg, -3.42); // (2823-2923)/2923*100
});

test("parseYahooQuote は chartPreviousClose 欠損時 previousClose を使う", () => {
  const { parseYahooQuote } = require("../lib/logic");
  const r = parseYahooQuote({ regularMarketPrice: 230, previousClose: 220 });
  assert.equal(r.price, 230);
  assert.equal(r.chg, 4.55); // (230-220)/220*100
});

test("parseYahooQuote は前日終値が無ければ chg=0", () => {
  const { parseYahooQuote } = require("../lib/logic");
  const r = parseYahooQuote({ regularMarketPrice: 100 });
  assert.equal(r.price, 100);
  assert.equal(r.chg, 0);
});

test("parseYahooQuote はエラー/欠損で null", () => {
  const { parseYahooQuote } = require("../lib/logic");
  assert.equal(parseYahooQuote(null), null);
  assert.equal(parseYahooQuote({}), null);
  assert.equal(parseYahooQuote({ regularMarketPrice: "N/A" }), null);
});

// ---------------------------------------------------------------------------
// 時間別天気の切り出し
// ---------------------------------------------------------------------------

test("sliceHourlyForecast は現在時刻以降を count 件切り出す", () => {
  const { sliceHourlyForecast } = require("../lib/logic");
  const times = [
    "2026-07-09T12:00",
    "2026-07-09T13:00",
    "2026-07-09T14:00",
    "2026-07-09T15:00",
  ];
  const temps = [20, 21, 22, 23];
  const pops = [0, 10, 20, 30];
  const now = new Date("2026-07-09T13:20:00");
  const r = sliceHourlyForecast(times, temps, pops, now, 2);
  assert.deepEqual(r.temp, [21, 22]);
  assert.deepEqual(r.pop, [10, 20]);
});

test("sliceHourlyForecast は該当時刻が無ければ最初の未来時刻から", () => {
  const { sliceHourlyForecast } = require("../lib/logic");
  const times = ["2026-07-09T12:00", "2026-07-09T13:00"];
  const now = new Date("2026-07-09T12:30:00");
  const r = sliceHourlyForecast(times, [20, 21], [0, 5], now, 5);
  assert.deepEqual(r.temp, [20, 21]); // 12:00 が現在の時（12時台）に一致
});

test("sliceHourlyForecast は空配列で null", () => {
  const { sliceHourlyForecast } = require("../lib/logic");
  assert.equal(sliceHourlyForecast([], [], [], new Date()), null);
  assert.equal(sliceHourlyForecast(null, null, null, new Date()), null);
});
