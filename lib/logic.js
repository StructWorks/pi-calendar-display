"use strict";

/**
 * 副作用のない純粋ロジック群（DESIGN.md §6.4 / §6.8）。
 * server.js から利用し、test/ から単体テストできるよう分離している。
 */

// ---------------------------------------------------------------------------
// 汎用
// ---------------------------------------------------------------------------

function pick(arr, i) {
  return Array.isArray(arr) ? arr[i] : undefined;
}

function roundOrNull(v) {
  return typeof v === "number" && isFinite(v) ? Math.round(v) : null;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// ---------------------------------------------------------------------------
// カレンダー仕分け（DESIGN.md §6.4）
// ---------------------------------------------------------------------------

/**
 * 1 イベントを buf（{today, tomorrow, allDay, location}）へ振り分ける。
 * ctx = { todayStart, tomorrowStart, keywords }。
 */
function classifyEvent(ev, cal, buf, ctx) {
  const isAllDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
  const title = (ev.summary || "").trim() || "(無題)";

  let startDate;
  if (isAllDay) {
    startDate = startOfDay(new Date(ev.start.date + "T00:00:00"));
  } else {
    startDate = startOfDay(new Date(ev.start.dateTime));
  }

  let when;
  if (startDate.getTime() === ctx.todayStart.getTime()) when = "today";
  else if (startDate.getTime() === ctx.tomorrowStart.getTime()) when = "tomorrow";
  else return; // 範囲外はスキップ。

  const isLocation =
    cal.role === "location" ||
    (isAllDay && (ctx.keywords || []).some((k) => title.includes(k)));

  if (isAllDay && isLocation) {
    buf.location[when] = title;
    return;
  }
  if (isAllDay) {
    // 終日の通常予定は当日分のみチップに出す。
    if (when === "today") buf.allDay.push({ label: title, calendar: cal.label });
    return;
  }

  const hhmm = (d) =>
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0");
  const item = { t: hhmm(new Date(ev.start.dateTime)), title, calendar: cal.label };
  // 終了時刻（タイムラインの長さ算出に使用）。無い場合は付けない。
  if (ev.end && ev.end.dateTime) item.end = hhmm(new Date(ev.end.dateTime));
  buf[when].push(item);
}

// ---------------------------------------------------------------------------
// 明るさ・表示モードのスケジュール（DESIGN.md §6.8）
// ---------------------------------------------------------------------------

function nowMinutes(d) {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

function parseHHMM(s) {
  const [h, m] = String(s).split(":").map(Number);
  return h * 60 + m;
}

/** schedule を時刻順に整列した [{from, value}] へ正規化する。 */
function normalizeSchedule(schedule, key) {
  return (schedule || [])
    .map((e) => ({ from: parseHHMM(e.from), value: e[key] }))
    .filter((e) => isFinite(e.from) && e.value != null)
    .sort((a, b) => a.from - b.from);
}

/** now が属する区間 index（巡回。先頭より前なら末尾区間）。 */
function currentSegmentIndex(entries, nowMin) {
  if (entries.length === 0) return -1;
  let idx = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].from <= nowMin) idx = i;
  }
  if (idx === -1) idx = entries.length - 1;
  return idx;
}

function clampLevel(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** 明るさを算出（区間境界の前後 transitionMinutes で線形補間）。 */
function computeBrightness(entries, nowMin, transitionMinutes) {
  if (entries.length === 0) return 100;
  const baseIdx = currentSegmentIndex(entries, nowMin);
  const baseLevel = entries[baseIdx].value;
  const T = Math.max(0, transitionMinutes || 0);
  if (T === 0 || entries.length === 1) return clampLevel(baseLevel);

  let result = baseLevel;
  for (let i = 0; i < entries.length; i++) {
    const boundary = entries[i].from;
    const before = entries[(i - 1 + entries.length) % entries.length].value;
    const after = entries[i].value;
    let delta = (nowMin - boundary + 1440) % 1440;
    if (delta > 720) delta -= 1440; // [-720, 720)
    if (Math.abs(delta) <= T / 2) {
      const frac = (delta + T / 2) / T; // -T/2→0(before), +T/2→1(after)
      result = before + (after - before) * frac;
      break;
    }
  }
  return clampLevel(result);
}

/** now(分) が [from, to) の時間帯に入るか（to<from は深夜跨ぎ）。 */
function withinWindow(nowMin, from, to) {
  if (from === to) return false;
  if (from < to) return nowMin >= from && nowMin < to;
  return nowMin >= from || nowMin < to; // 深夜を跨ぐ
}

// ---------------------------------------------------------------------------
// 月/週カレンダー用の日付別イベント変換
// ---------------------------------------------------------------------------

/** Date → ローカルの "YYYY-MM-DD"。 */
function localDateKey(d) {
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

/**
 * イベントを「日付キー + 表示用アイテム」に変換する（月/週ビュー用）。
 * 終日は start.date をキーに allDay:true。時刻つきは開始日をキーに t(/end) を付ける。
 */
function monthEventOf(ev, cal) {
  const title = (ev.summary || "").trim() || "(無題)";
  const isAllDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
  if (isAllDay) {
    return {
      key: ev.start.date, // 既に "YYYY-MM-DD"
      item: { title, calendar: cal.label, allDay: true },
    };
  }
  const hhmm = (d) =>
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0");
  const start = new Date(ev.start.dateTime);
  const item = { t: hhmm(start), title, calendar: cal.label };
  if (ev.end && ev.end.dateTime) item.end = hhmm(new Date(ev.end.dateTime));
  return { key: localDateKey(start), item };
}

// ---------------------------------------------------------------------------
// 株価（Yahoo Finance chart API）と時間別天気（Open-Meteo hourly）— portrait ビュー用
// ---------------------------------------------------------------------------

/**
 * Yahoo Finance chart API（v8）の meta オブジェクト
 * （{ regularMarketPrice, chartPreviousClose, previousClose, ... }）から
 * { price: 現在値, chg: 前日比% } を返す。エラー/欠損時は null。
 */
function parseYahooQuote(meta) {
  if (!meta || typeof meta !== "object") return null;
  const price = Number(meta.regularMarketPrice);
  if (!isFinite(price)) return null;
  // 前日終値は chartPreviousClose を優先、無ければ previousClose。
  const prev = Number(
    meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose
  );
  const chg = isFinite(prev) && prev ? ((price - prev) / prev) * 100 : 0;
  return {
    price: Math.round(price * 100) / 100,
    chg: Math.round(chg * 100) / 100,
  };
}

/**
 * Open-Meteo の hourly 配列から「現在時刻以降の count 時間」を切り出す。
 * times は "YYYY-MM-DDTHH:MM" のローカル時刻文字列。
 * 戻り値 { temp:[…], pop:[…] }。データが無ければ null。
 */
function sliceHourlyForecast(times, temps, pops, now, count) {
  count = count || 12;
  if (!Array.isArray(times) || times.length === 0) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const key =
    now.getFullYear() +
    "-" +
    pad(now.getMonth() + 1) +
    "-" +
    pad(now.getDate()) +
    "T" +
    pad(now.getHours());
  let start = times.findIndex(
    (t) => typeof t === "string" && t.slice(0, 13) === key
  );
  if (start === -1) {
    start = times.findIndex((t) => new Date(t).getTime() >= now.getTime());
  }
  if (start === -1) start = 0;
  const temp = [];
  const pop = [];
  for (let i = start; i < times.length && temp.length < count; i++) {
    temp.push(roundOrNull(pick(temps, i)));
    pop.push(roundOrNull(pick(pops, i)));
  }
  return { temp, pop };
}

module.exports = {
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
  withinWindow,
  localDateKey,
  monthEventOf,
  parseYahooQuote,
  sliceHourlyForecast,
};
