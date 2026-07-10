"use strict";

/**
 * pi-calendar-display プロキシ本体。
 *
 * 責務（DESIGN.md §6）:
 *  - config.json を読み込み、token.json から OAuth クレデンシャルを復元する。
 *  - 一定間隔でカレンダーと天気を取得し、メモリ上の cache を更新する。
 *  - スケジュールから現在の明るさ・表示モードを算出して cache.display に反映する。
 *  - /api/data でキャッシュを返し、/api/command でリモコン操作を処理する。
 *  - /auth・/oauth2callback で初回 OAuth フローを処理する。
 *  - public/ を静的配信する（index.html = キオスク, remote.html = リモコン）。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");
const express = require("express");
const { google } = require("googleapis");
const logic = require("./lib/logic");

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
  withinWindow,
  localDateKey,
  monthEventOf,
  parseTwelveQuote,
  groupStocksByExchange,
  sliceHourlyForecast,
} = logic;

const ROOT = __dirname;
// 設定/トークン/.env のパスは環境変数で上書き可能（テスト用）。
const CONFIG_PATH = process.env.PCD_CONFIG || path.join(ROOT, "config.json");
const TOKEN_PATH = process.env.PCD_TOKEN || path.join(ROOT, "token.json");
const ENV_PATH = process.env.PCD_ENV || path.join(ROOT, ".env");
const STATE_PATH = process.env.PCD_STATE || path.join(ROOT, "state.json");
const PUBLIC_DIR = path.join(ROOT, "public");

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const IMG_EXT_RE = /^bg.*\.(jpe?g|png|webp)$/i;

// ---------------------------------------------------------------------------
// 設定読み込み（.env → config.json をマージ。env が優先）
// ---------------------------------------------------------------------------

// 依存を増やさない最小の .env パーサ。KEY=VALUE 形式、# 始まりはコメント。
function loadDotEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let [, key, val] = m;
    val = val.trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val; // 実環境変数を優先
  }
}

function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      console.error("[config] config.json の解析に失敗しました:", err.message);
      process.exit(1);
    }
  } else {
    console.warn(
      "[config] config.json が見つかりません。.env と既定値のみで起動します。"
    );
  }
  return cfg;
}

// 環境変数を config にマージする（env が config.json より優先）。
function applyEnv(cfg) {
  const E = process.env;
  cfg.google = cfg.google || {};
  if (E.GOOGLE_CLIENT_ID) cfg.google.clientId = E.GOOGLE_CLIENT_ID;
  if (E.GOOGLE_CLIENT_SECRET) cfg.google.clientSecret = E.GOOGLE_CLIENT_SECRET;
  if (E.GOOGLE_REDIRECT_URI) cfg.google.redirectUri = E.GOOGLE_REDIRECT_URI;

  cfg.weather = cfg.weather || {};
  if (E.WEATHER_LATITUDE) cfg.weather.latitude = Number(E.WEATHER_LATITUDE);
  if (E.WEATHER_LONGITUDE) cfg.weather.longitude = Number(E.WEATHER_LONGITUDE);
  if (E.WEATHER_LOCATION_NAME) cfg.weather.locationName = E.WEATHER_LOCATION_NAME;
  if (E.WEATHER_TIMEZONE) cfg.weather.timezone = E.WEATHER_TIMEZONE;

  // 株価 API キーは .env（TWELVE_DATA_API_KEY）を優先。
  cfg.stocks = cfg.stocks || {};
  if (E.TWELVE_DATA_API_KEY) cfg.stocks.apiKey = E.TWELVE_DATA_API_KEY;

  cfg.server = cfg.server || {};
  if (E.PORT) cfg.server.port = Number(E.PORT);

  // CALENDARS は JSON 配列文字列で全体指定（例: [{"id":"primary","label":"メイン","role":"events"}]）。
  if (E.CALENDARS) {
    try {
      cfg.calendars = JSON.parse(E.CALENDARS);
    } catch (err) {
      console.error("[config] CALENDARS の JSON 解析に失敗:", err.message);
    }
  }

  // redirectUri の既定値（未設定ならポートに合わせる）。
  if (!cfg.google.redirectUri) {
    cfg.google.redirectUri = `http://localhost:${
      (cfg.server && cfg.server.port) || 3000
    }/oauth2callback`;
  }
  return cfg;
}

loadDotEnv();
const config = applyEnv(loadConfig());

if (!config.google.clientId || !config.google.clientSecret) {
  console.warn(
    "[config] Google の clientId/clientSecret が未設定です。天気のみで起動します（カレンダー連携は不可）。"
  );
}

const PORT = (config.server && config.server.port) || 3000;
const CAL_REFRESH_MS =
  ((config.server && config.server.calendarRefreshSeconds) || 60) * 1000;
const WEATHER_REFRESH_MS =
  ((config.server && config.server.weatherRefreshSeconds) || 1800) * 1000;

// 株価（portrait ビュー用。Twelve Data quote）。config.stocks で指定、最大8銘柄。
const stocksCfg = config.stocks || {};
const STOCK_REFRESH_MS = (stocksCfg.refreshSeconds || 300) * 1000;
const STOCK_API_KEY = stocksCfg.apiKey || "";
const STOCK_SYMBOLS = (Array.isArray(stocksCfg.symbols) ? stocksCfg.symbols : [])
  .slice(0, 8)
  .map((s) => {
    const symbol = typeof s === "string" ? s : s && s.symbol;
    const label =
      (s && s.label) ||
      String(symbol || "")
        .replace(/^\^/, "")
        .toUpperCase();
    // 取引所の指定（日本株など）。mic_code / exchange / country のいずれか。
    const exchange = (s && s.exchange) || "";
    const mic = (s && (s.mic || s.mic_code)) || "";
    const country = (s && s.country) || "";
    return { symbol, label, exchange, mic, country };
  })
  .filter((s) => s.symbol);
const STOCKS_ENABLED =
  stocksCfg.enabled !== false && STOCK_SYMBOLS.length > 0 && !!STOCK_API_KEY;
if (stocksCfg.enabled !== false && STOCK_SYMBOLS.length > 0 && !STOCK_API_KEY) {
  console.warn(
    "[stocks] Twelve Data の API キーが未設定です（stocks.apiKey / TWELVE_DATA_API_KEY）。株価は無効化されます。"
  );
}

const remoteCfg = config.remote || {};
const REMOTE_ENABLED = remoteCfg.enabled !== false;
const UPLOAD_MAX_BYTES = 12 * 1024 * 1024; // 12MB
const UPLOAD_KEEP = 20; // アップロード背景の保持上限（古いものから間引く）

// 背景リストは可変。config の指定 + public/ 内の bg*.{jpg,png,webp} を統合する
// （/remote からアップロードした画像は再起動後もディスク走査で拾われる）。
function scanBackgrounds() {
  const fromConfig =
    Array.isArray(remoteCfg.backgrounds) && remoteCfg.backgrounds.length > 0
      ? remoteCfg.backgrounds.slice()
      : ["bg.jpg"];
  let onDisk = [];
  try {
    onDisk = fs.readdirSync(PUBLIC_DIR).filter((f) => IMG_EXT_RE.test(f));
  } catch {
    onDisk = [];
  }
  const merged = fromConfig.slice();
  for (const f of onDisk.sort()) if (!merged.includes(f)) merged.push(f);
  return merged;
}
let backgrounds = scanBackgrounds();

// 自動ナイトの時間帯（/remote から変更可、state.json に永続化）。config を初期値とする。
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const cfgNight = ((config.display || {}).view || {}).night || {};
const runtimeNight = {
  enabled: !!(cfgNight.from && cfgNight.to),
  from: HHMM_RE.test(cfgNight.from) ? cfgNight.from : "23:00",
  to: HHMM_RE.test(cfgNight.to) ? cfgNight.to : "06:00",
};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return;
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (s.night && typeof s.night === "object") {
      if (typeof s.night.enabled === "boolean") runtimeNight.enabled = s.night.enabled;
      if (HHMM_RE.test(s.night.from)) runtimeNight.from = s.night.from;
      if (HHMM_RE.test(s.night.to)) runtimeNight.to = s.night.to;
    }
  } catch (err) {
    console.error("[state] state.json の読み込みに失敗:", err.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ night: runtimeNight }, null, 2));
  } catch (err) {
    console.error("[state] state.json の保存に失敗:", err.message);
  }
}

loadState();

// ---------------------------------------------------------------------------
// キャッシュ（フロントとの契約。DESIGN.md §6.3）
// ---------------------------------------------------------------------------

const cache = {
  today: [],
  tomorrow: [],
  allDay: [],
  location: { today: null, tomorrow: null },
  events: {}, // 月/週ビュー用。"YYYY-MM-DD" → [{ t?, end?, title, calendar, allDay? }]
  weather: null,
  stocks: [], // portrait ビュー用。[{ sym, price, chg }]
  display: {
    brightness: 100,
    brightnessOverride: null,
    view: "full",
    viewOverride: null,
    background: backgrounds[0],
    screen: "on",
    night: runtimeNight, // 自動ナイトの時間帯（/remote で設定）
  },
  syncedAt: null,
};

// override がどのスケジュール区間で設定されたかを記録し、区間をまたいだら自動解除する。
let brightnessOverrideSegment = null;
let viewOverrideSegment = null;
// 自動ナイト（時間帯）の状態。入場時の表示モードを覚え、退場時に復帰する。
let nightActive = false;
let preNightView = null;

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

const oauth2Client = new google.auth.OAuth2(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
);

let isAuthed = false;
let pendingAuthState = null; // OAuth state（/auth で発行し /oauth2callback で照合）

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return;
  try {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    oauth2Client.setCredentials(token);
    isAuthed = true;
    // 既存ファイルが緩い権限なら所有者のみ(0o600)へ厳格化する。
    try {
      if ((fs.statSync(TOKEN_PATH).mode & 0o077) !== 0) {
        fs.chmodSync(TOKEN_PATH, 0o600);
      }
    } catch {
      /* 権限変更不可（Windows等）は無視 */
    }
  } catch (err) {
    console.error("[oauth] token.json の読み込みに失敗しました:", err.message);
  }
}

// アクセストークンが自動更新されるたびに token.json へマージ保存する（放置運用の肝）。
oauth2Client.on("tokens", (tokens) => {
  let current = {};
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      current = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    } catch {
      current = {};
    }
  }
  const merged = { ...current, ...tokens };
  // refresh_token は再発行されないことがあるため、既存値を温存する。
  if (!merged.refresh_token && current.refresh_token) {
    merged.refresh_token = current.refresh_token;
  }
  try {
    // 所有者のみ読み書き可（0o600）で保存。トークンを world-readable にしない。
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
    oauth2Client.setCredentials(merged);
    isAuthed = true;
  } catch (err) {
    console.error("[oauth] token.json の保存に失敗しました:", err.message);
  }
});

// ---------------------------------------------------------------------------
// 天気取得（Open-Meteo。DESIGN.md §6.5）
// ---------------------------------------------------------------------------

async function fetchWeather() {
  const w = config.weather;
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${encodeURIComponent(w.latitude)}` +
    `&longitude=${encodeURIComponent(w.longitude)}` +
    "&current=temperature_2m,apparent_temperature,weather_code" +
    "&hourly=temperature_2m,precipitation_probability" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    `&timezone=${encodeURIComponent(w.timezone)}` +
    "&forecast_days=2";

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const daily = data.daily || {};
    const day = (i) => ({
      code: pick(daily.weather_code, i),
      max: roundOrNull(pick(daily.temperature_2m_max, i)),
      min: roundOrNull(pick(daily.temperature_2m_min, i)),
      pop: roundOrNull(pick(daily.precipitation_probability_max, i)),
    });

    // 現在時刻以降12時間の気温・降水確率（portrait のストリップ用）。
    const hourly = data.hourly || {};
    const strip =
      sliceHourlyForecast(
        hourly.time,
        hourly.temperature_2m,
        hourly.precipitation_probability,
        new Date(),
        12
      ) || { temp: [], pop: [] };

    cache.weather = {
      current: {
        temp: roundOrNull(data.current && data.current.temperature_2m),
        feels: roundOrNull(data.current && data.current.apparent_temperature),
        code: data.current && data.current.weather_code,
      },
      today: day(0),
      tomorrow: day(1),
      hourly: strip.temp,
      pop: strip.pop,
      locationName: w.locationName,
    };
  } catch (err) {
    // 失敗時は前回値を保持（DESIGN.md §6.7）。
    console.error("[weather] 取得失敗:", err.message);
  }
}

// ---------------------------------------------------------------------------
// 株価取得（Twelve Data quote。portrait ビュー用）。全銘柄を1リクエストでバッチ取得。
// ---------------------------------------------------------------------------

// 銘柄ごとの最終取得値。個別銘柄が一時的に失敗しても前回値を保つ。
const lastStock = {};

// 1取引所グループ（同一 exchange/mic/country）を1リクエストで取得する。
async function fetchStockGroup(group) {
  const symbols = group.items.map((s) => s.symbol).join(",");
  let url =
    "https://api.twelvedata.com/quote" +
    `?symbol=${encodeURIComponent(symbols)}` +
    `&apikey=${encodeURIComponent(STOCK_API_KEY)}&dp=2`;
  if (group.exchange) url += `&exchange=${encodeURIComponent(group.exchange)}`;
  if (group.mic) url += `&mic_code=${encodeURIComponent(group.mic)}`;
  if (group.country) url += `&country=${encodeURIComponent(group.country)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // レスポンス全体のエラー（不正キー・レート超過・プラン外など）。
    if (data && data.status === "error") {
      throw new Error(data.message || "API エラー");
    }
    // 複数銘柄は symbol をキーにした連想配列、単一銘柄は quote を直接返す。
    for (const { symbol, label } of group.items) {
      const q = group.items.length === 1 ? data : data[symbol];
      const parsed = parseTwelveQuote(q);
      if (parsed) {
        lastStock[label] = { sym: label, price: parsed.price, chg: parsed.chg };
      } else {
        console.error(`[stocks] "${symbol}" のクォート取得に失敗`);
      }
    }
  } catch (err) {
    console.error(`[stocks] グループ取得失敗 (${symbols}):`, err.message);
  }
}

async function fetchStocks() {
  if (!STOCKS_ENABLED) return;
  // 取引所ごとにグループ化して並列取得（バッチは取引所指定が全銘柄共通のため）。
  const groups = groupStocksByExchange(STOCK_SYMBOLS);
  await Promise.all(groups.map((g) => fetchStockGroup(g)));

  // config の並び順で、取得済みのものだけを並べる。
  cache.stocks = STOCK_SYMBOLS.map(({ label }) => lastStock[label]).filter(
    Boolean
  );
}

// ---------------------------------------------------------------------------
// デモモード（PCD_DEMO=1）。OAuth 不要でサンプル予定を表示する（スクショ・動作確認用）。
// ---------------------------------------------------------------------------

const DEMO = ["1", "true", "yes"].includes(
  String(process.env.PCD_DEMO || "").toLowerCase()
);

function seedDemoData() {
  cache.today = [
    { t: "09:30", end: "10:00", title: "朝会 / デイリースクラム", calendar: "メイン" },
    { t: "11:00", end: "11:30", title: "1on1 田中さん", calendar: "メイン" },
    { t: "14:00", end: "15:30", title: "設計レビュー", calendar: "仕事" },
    { t: "16:30", end: "17:00", title: "請求書チェック", calendar: "仕事" },
    { t: "19:30", end: "21:00", title: "ジム", calendar: "プライベート" },
  ];
  cache.tomorrow = [
    { t: "10:00", end: "11:00", title: "顧客MTG（オンライン）", calendar: "仕事" },
    { t: "12:30", end: "13:30", title: "ランチ 佐藤さん", calendar: "プライベート" },
    { t: "16:00", end: "16:45", title: "歯医者", calendar: "プライベート" },
  ];
  cache.allDay = [
    { label: "請求書の締め", calendar: "メイン" },
    { label: "資源ごみ", calendar: "プライベート" },
  ];
  cache.location = { today: "在宅勤務", tomorrow: "出社" };

  // portrait 用の天気（現在＋今日/明日＋これからの12時間）。
  cache.weather = {
    current: { temp: 24, feels: 26, code: 2 },
    today: { code: 1, max: 27, min: 19, pop: 20 },
    tomorrow: { code: 63, max: 23, min: 17, pop: 70 },
    hourly: [24, 25, 26, 27, 27, 26, 24, 22, 21, 20, 20, 19],
    pop: [10, 10, 20, 20, 30, 40, 60, 70, 65, 50, 40, 30],
    locationName: (config.weather && config.weather.locationName) || "東京",
  };
  // portrait 用の株価（最大8）。
  cache.stocks = [
    { sym: "AAPL", price: 232.15, chg: 1.24 },
    { sym: "MSFT", price: 498.3, chg: -0.42 },
    { sym: "NVDA", price: 178.6, chg: 2.85 },
    { sym: "GOOGL", price: 201.44, chg: 0.63 },
    { sym: "AMZN", price: 224.9, chg: -1.08 },
    { sym: "トヨタ", price: 2985, chg: -1.1 },
    { sym: "SBG", price: 11230, chg: 3.05 },
    { sym: "日経225", price: 41250, chg: 0.85 },
  ];

  // 月/週ビュー用のサンプル（実日付基準で散らす）。
  const now = new Date();
  const ev = {};
  const keyOf = (offset) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return localDateKey(d);
  };
  const add = (offset, item) => {
    const k = keyOf(offset);
    (ev[k] = ev[k] || []).push(item);
  };
  cache.today.forEach((e) => add(0, e));
  cache.tomorrow.forEach((e) => add(1, e));
  cache.allDay.forEach((c) =>
    add(0, { title: c.label, calendar: c.calendar, allDay: true })
  );
  // 今月の他の日にも散らす。
  add(-12, { t: "13:00", end: "14:00", title: "四半期レビュー", calendar: "仕事" });
  add(-7, { title: "資源ごみ", calendar: "プライベート", allDay: true });
  add(-5, { t: "18:30", end: "20:30", title: "誕生日ディナー", calendar: "プライベート" });
  add(-2, { t: "10:00", end: "10:30", title: "定例会議", calendar: "仕事" });
  add(2, { t: "15:00", end: "16:00", title: "美容院", calendar: "プライベート" });
  add(3, { title: "有給", calendar: "メイン", allDay: true });
  add(4, { t: "09:00", end: "18:00", title: "出張（大阪）", calendar: "仕事" });
  add(6, { t: "11:00", end: "12:00", title: "面談", calendar: "仕事" });
  add(9, { t: "19:00", end: "22:00", title: "ライブ", calendar: "プライベート" });
  add(13, { t: "14:00", end: "15:00", title: "歯科 検診", calendar: "プライベート" });
  add(-3, { t: "16:00", end: "17:00", title: "1on1 鈴木さん", calendar: "メイン" });
  cache.events = ev;
}

// ---------------------------------------------------------------------------
// カレンダー取得と仕分け（DESIGN.md §6.4）。仕分けロジックは lib/logic.js。
// ---------------------------------------------------------------------------

function fetchCalendars() {
  if (DEMO) return Promise.resolve(); // デモ中はサンプルを保持
  if (!isAuthed) return Promise.resolve();

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const now = new Date();
  const todayStart = startOfDay(now);
  const tomorrowStart = new Date(todayStart.getTime() + 86400000);
  const dayAfterStart = new Date(todayStart.getTime() + 2 * 86400000);

  // 月ビューのグリッド範囲（今月を含む6週間、週は日曜始まり）。週ビューもこの範囲に収まる。
  const monthFirst = new Date(now.getFullYear(), now.getMonth(), 1);
  const gridStart = new Date(monthFirst);
  gridStart.setDate(monthFirst.getDate() - monthFirst.getDay()); // 直前の日曜
  const gridEnd = new Date(gridStart.getTime() + 42 * 86400000); // 6週間

  const keywords = config.allDayLocationKeywords || [];
  const calendars = config.calendars || [];

  // 一時バッファ（全カレンダーぶんをまとめてから cache へ反映）。
  const buf = {
    today: [],
    tomorrow: [],
    allDay: [],
    location: { today: null, tomorrow: null },
  };
  const eventsByDate = {}; // 月/週ビュー用

  const tasks = calendars.map(async (cal) => {
    try {
      const res = await calendar.events.list({
        calendarId: cal.id,
        timeMin: gridStart.toISOString(),
        timeMax: gridEnd.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 2500,
      });
      const events = (res.data && res.data.items) || [];
      for (const ev of events) {
        // ダッシュボード用（今日/明日/終日/勤務場所）。
        classifyEvent(ev, cal, buf, {
          todayStart,
          tomorrowStart,
          dayAfterStart,
          keywords,
        });
        // 月/週ビュー用（全イベントを日付別に収集）。
        const me = monthEventOf(ev, cal);
        (eventsByDate[me.key] = eventsByDate[me.key] || []).push(me.item);
      }
    } catch (err) {
      // 当該カレンダーをスキップ。他カレンダー・天気は継続（DESIGN.md §6.7）。
      console.error(`[calendar] "${cal.label}" 取得失敗:`, err.message);
    }
  });

  return Promise.all(tasks).then(() => {
    buf.today.sort((a, b) => a.t.localeCompare(b.t));
    buf.tomorrow.sort((a, b) => a.t.localeCompare(b.t));
    // 各日の予定を「終日→時刻順」に整列。
    for (const k of Object.keys(eventsByDate)) {
      eventsByDate[k].sort((a, b) => {
        if (a.allDay && !b.allDay) return -1;
        if (!a.allDay && b.allDay) return 1;
        return (a.t || "").localeCompare(b.t || "");
      });
    }
    cache.today = buf.today;
    cache.tomorrow = buf.tomorrow;
    cache.allDay = buf.allDay;
    cache.location = buf.location;
    cache.events = eventsByDate;
  });
}

// ---------------------------------------------------------------------------
// 明るさ・表示モードのスケジュール（DESIGN.md §6.8）。算出は lib/logic.js。
// ---------------------------------------------------------------------------

/** スケジュールと override から cache.display.brightness / view を更新する。 */
function updateDisplaySchedule() {
  const now = new Date();
  const nowMin = nowMinutes(now);
  const dcfg = (config.display || {});
  const bcfg = dcfg.brightness || {};
  const vcfg = dcfg.view || {};

  const bEntries = normalizeSchedule(bcfg.schedule, "level");
  const vEntries = normalizeSchedule(vcfg.schedule, "mode");

  const bSeg = currentSegmentIndex(bEntries, nowMin);
  const vSeg = currentSegmentIndex(vEntries, nowMin);

  // override は区間をまたいだ時点で自動解除（DESIGN.md §6.8）。
  if (cache.display.brightnessOverride != null && bSeg !== brightnessOverrideSegment) {
    cache.display.brightnessOverride = null;
    brightnessOverrideSegment = null;
  }
  if (cache.display.viewOverride != null && vSeg !== viewOverrideSegment) {
    cache.display.viewOverride = null;
    viewOverrideSegment = null;
  }

  cache.display.brightness =
    cache.display.brightnessOverride != null
      ? cache.display.brightnessOverride
      : bEntries.length
      ? computeBrightness(bEntries, nowMin, bcfg.transitionMinutes)
      : 100;

  // スケジュール/override による基本の表示モード。
  const baseView =
    cache.display.viewOverride != null
      ? cache.display.viewOverride
      : vEntries.length
      ? vEntries[vSeg].value
      : "full";

  // 自動ナイト（時間帯）。入場時の表示モードを覚え、退場時にそれへ復帰する。
  // 時間帯は runtimeNight（/remote で設定、state.json に永続化）。
  const inNight =
    runtimeNight.enabled &&
    withinWindow(nowMin, parseHHMM(runtimeNight.from), parseHHMM(runtimeNight.to));

  if (inNight) {
    if (!nightActive) {
      nightActive = true;
      preNightView = baseView; // 直前のモードを記憶
    }
    // ナイト中も手動 override があればそちらを優先（任意で別モードに切替可）。
    cache.display.view =
      cache.display.viewOverride != null ? cache.display.viewOverride : "night";
  } else {
    if (nightActive) {
      nightActive = false;
      // 退場時、手動 override が無ければ「入場前のモード」へ復帰する。
      if (
        cache.display.viewOverride == null &&
        preNightView &&
        preNightView !== "night"
      ) {
        cache.display.viewOverride = preNightView;
        viewOverrideSegment = vSeg;
      }
      preNightView = null;
    }
    cache.display.view = baseView;
  }

  // method が software 以外の将来拡張はここで実機へ書き込む（DESIGN.md §6.8）。
}

// ---------------------------------------------------------------------------
// リモコンのコマンド処理（DESIGN.md §6.9）
// ---------------------------------------------------------------------------

const BRIGHTNESS_STEPS = [100, 50, 15];
const VIEW_MODES = ["full", "timeline", "week", "month", "night"];

function setBrightnessOverride(level) {
  cache.display.brightnessOverride = clampLevel(level);
  cache.display.brightness = cache.display.brightnessOverride;
  brightnessOverrideSegment = currentSegmentIndex(
    normalizeSchedule((config.display?.brightness || {}).schedule, "level"),
    nowMinutes(new Date())
  );
}

function setViewOverride(mode) {
  cache.display.viewOverride = mode;
  cache.display.view = mode;
  viewOverrideSegment = currentSegmentIndex(
    normalizeSchedule((config.display?.view || {}).schedule, "mode"),
    nowMinutes(new Date())
  );
}

function runScreenPower(on) {
  const cmds = remoteCfg.screenPower || {};
  const cmd = on ? cmds.on : cmds.off;
  if (!cmd) return; // 未設定なら画面電源制御を無効化。
  exec(cmd, (err) => {
    if (err) console.error("[screen] コマンド失敗:", err.message);
  });
  cache.display.screen = on ? "on" : "off";
}

/** コマンドを実行。{ ok, status, error } を返す。 */
function handleCommand(action, value) {
  switch (action) {
    case "nextBackground":
    case "prevBackground": {
      const list = backgrounds;
      const cur = list.indexOf(cache.display.background);
      const dir = action === "nextBackground" ? 1 : -1;
      const next = (cur + dir + list.length) % list.length;
      cache.display.background = list[next];
      return { ok: true };
    }
    case "setBackground": {
      if (!backgrounds.includes(value)) {
        return { ok: false, status: 400, error: "許可外の背景です" };
      }
      cache.display.background = value;
      return { ok: true };
    }
    case "refresh":
    case "resync":
      runSync(); // 即時再取得（待たずに返す）。
      return { ok: true };
    case "screenPower": {
      let on;
      if (value === "on") on = true;
      else if (value === "off") on = false;
      else on = cache.display.screen !== "on"; // トグル。
      runScreenPower(on);
      return { ok: true };
    }
    case "setBrightness": {
      const n = Number(value);
      if (!isFinite(n) || n < 0 || n > 100) {
        return { ok: false, status: 400, error: "0〜100 で指定してください" };
      }
      setBrightnessOverride(n);
      return { ok: true };
    }
    case "cycleBrightness": {
      const cur = cache.display.brightness;
      // 現在値以下で最も近い段階の次へ。
      let idx = BRIGHTNESS_STEPS.findIndex((s) => s <= cur);
      if (idx === -1) idx = 0;
      const next = BRIGHTNESS_STEPS[(idx + 1) % BRIGHTNESS_STEPS.length];
      setBrightnessOverride(next);
      return { ok: true };
    }
    case "clearBrightness":
      cache.display.brightnessOverride = null;
      brightnessOverrideSegment = null;
      updateDisplaySchedule();
      return { ok: true };
    case "setView": {
      if (!VIEW_MODES.includes(value)) {
        return { ok: false, status: 400, error: "許可外の表示モードです" };
      }
      setViewOverride(value);
      return { ok: true };
    }
    case "cycleView": {
      const cur = cache.display.view;
      const idx = VIEW_MODES.indexOf(cur);
      const next = VIEW_MODES[(idx + 1) % VIEW_MODES.length];
      setViewOverride(next);
      return { ok: true };
    }
    case "setNightWindow": {
      // value = { enabled?: bool, from?: "HH:MM", to?: "HH:MM" }
      const v = value || {};
      if (v.from != null && !HHMM_RE.test(v.from)) {
        return { ok: false, status: 400, error: "from は HH:MM 形式で" };
      }
      if (v.to != null && !HHMM_RE.test(v.to)) {
        return { ok: false, status: 400, error: "to は HH:MM 形式で" };
      }
      if (v.from != null) runtimeNight.from = v.from;
      if (v.to != null) runtimeNight.to = v.to;
      if (typeof v.enabled === "boolean") runtimeNight.enabled = v.enabled;
      saveState();
      updateDisplaySchedule(); // 即時反映
      return { ok: true };
    }
    default:
      return { ok: false, status: 400, error: "未知の action です" };
  }
}

// ---------------------------------------------------------------------------
// 定期同期
// ---------------------------------------------------------------------------

async function runSync() {
  await Promise.all([fetchCalendars(), maybeFetchWeather(), maybeFetchStocks()]);
  cache.syncedAt = new Date().toISOString();
}

let lastWeatherAt = 0;
async function maybeFetchWeather() {
  if (DEMO) return; // デモ中は seedDemoData の値を保持
  const now = Date.now();
  if (now - lastWeatherAt >= WEATHER_REFRESH_MS || cache.weather == null) {
    lastWeatherAt = now;
    await fetchWeather();
  }
}

let lastStocksAt = 0;
async function maybeFetchStocks() {
  if (DEMO || !STOCKS_ENABLED) return;
  const now = Date.now();
  if (now - lastStocksAt >= STOCK_REFRESH_MS || cache.stocks.length === 0) {
    lastStocksAt = now;
    await fetchStocks();
  }
}

// マジックバイトから画像拡張子を判定（不正/実行ファイルの保存を防ぐ）。
function detectImageExt(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return "jpg";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
    return "png";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  return null;
}

// ---------------------------------------------------------------------------
// HTTP サーバ
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// CSRF/DNSリバインディング対策の多層防御。ブラウザは別オリジンからの POST 時に
// Origin ヘッダを送るため、Origin が存在し Host と一致しなければ拒否する
// （Origin 無し = 非ブラウザ/同一オリジンのヘッダ無しは許可）。LAN内信頼前提は維持しつつ、
// ユーザーが閲覧した悪意サイトからローカルプロキシを操作される事故を防ぐ。
function crossOriginBlocked(req, res) {
  const origin = req.get("origin");
  if (!origin) return false;
  let ok = false;
  try {
    ok = new URL(origin).host === req.get("host");
  } catch {
    ok = false;
  }
  if (!ok) {
    res.status(403).json({ error: "cross-origin request rejected" });
    return true;
  }
  return false;
}

app.get("/api/data", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(cache);
});

app.post("/api/command", (req, res) => {
  if (!REMOTE_ENABLED) return res.status(404).json({ error: "remote disabled" });
  if (crossOriginBlocked(req, res)) return;
  const { action, value } = req.body || {};
  const result = handleCommand(action, value);
  if (!result.ok) {
    return res.status(result.status || 400).json({ error: result.error });
  }
  res.json({ display: cache.display });
});

// 背景画像アップロード（/remote から）。生バイナリを受け取りマジックバイトで検証する。
app.post(
  "/api/background",
  express.raw({ type: () => true, limit: UPLOAD_MAX_BYTES }),
  (req, res) => {
    if (!REMOTE_ENABLED) return res.status(404).json({ error: "remote disabled" });
    if (crossOriginBlocked(req, res)) return;
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ error: "画像データがありません" });
    }
    const ext = detectImageExt(buf);
    if (!ext) {
      return res
        .status(400)
        .json({ error: "対応画像（JPEG/PNG/WebP）ではありません" });
    }
    // ファイル名はサーバ側で生成（パストラバーサル・上書き防止）。
    const name = `bg-upload-${Date.now()}.${ext}`;
    try {
      fs.writeFileSync(path.join(PUBLIC_DIR, name), buf);
    } catch (err) {
      console.error("[upload] 保存失敗:", err.message);
      return res.status(500).json({ error: "保存に失敗しました" });
    }
    if (!backgrounds.includes(name)) backgrounds.push(name);
    cache.display.background = name; // アップロード直後にその画像へ切替
    pruneUploads(name); // ディスク枯渇対策に古いアップロードを間引く
    res.json({ display: cache.display, backgrounds });
  }
);

// アップロード画像(bg-upload-*)を最大 UPLOAD_KEEP 件に保つ。
// 現在表示中の画像は消さない。config 指定や手置き画像(bg.jpg 等)は対象外。
function pruneUploads(keepName) {
  const uploads = backgrounds
    .filter((n) => /^bg-upload-/.test(n))
    .sort(); // 名前にタイムスタンプ → 昇順 = 古い順
  const excess = uploads.length - UPLOAD_KEEP;
  if (excess <= 0) return;
  for (const name of uploads.slice(0, excess)) {
    if (name === keepName || name === cache.display.background) continue;
    try {
      fs.rmSync(path.join(PUBLIC_DIR, name), { force: true });
    } catch (err) {
      console.error("[upload] 古い画像の削除に失敗:", err.message);
      continue;
    }
    backgrounds = backgrounds.filter((n) => n !== name);
  }
}

app.get("/auth", (req, res) => {
  // OAuth CSRF 対策: ランダムな state を発行し、コールバックで照合する。
  pendingAuthState = crypto.randomBytes(16).toString("hex");
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [CALENDAR_SCOPE],
    state: pendingAuthState,
  });
  res.redirect(url);
});

app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("認可コードがありません");
  // state を照合（不一致・未発行は拒否）。
  if (!pendingAuthState || req.query.state !== pendingAuthState) {
    return res.status(400).send("state が一致しません（不正なコールバック）");
  }
  pendingAuthState = null; // 使い捨て
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens); // "tokens" イベントで token.json に保存される。
    isAuthed = true;
    await runSync();
    res.send("認証に成功しました。この画面は閉じて構いません。");
  } catch (err) {
    console.error("[oauth] トークン取得失敗:", err.message);
    res.status(500).send("認証に失敗しました: " + err.message);
  }
});

// /remote はリモコンページ。remote.enabled が false なら 404。
app.get("/remote", (req, res) => {
  if (!REMOTE_ENABLED) return res.status(404).send("remote disabled");
  res.sendFile(path.join(PUBLIC_DIR, "remote.html"));
});

// /portrait は24インチ縦置き用のダッシュボード（時計・天気・予定・ミニ暦・株価）。
app.get("/portrait", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "portrait.html"));
});

app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

loadToken();
updateDisplaySchedule();
if (DEMO) seedDemoData();

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}/ で待機中`);
  if (DEMO) {
    console.log("[server] デモモード: サンプル予定を表示中（PCD_DEMO）");
  } else if (!isAuthed) {
    console.log(
      `[server] 未認証です。ブラウザで http://localhost:${PORT}/auth を開いて認証してください。`
    );
  }
});

// 初回取得と定期実行。
runSync();
setInterval(runSync, CAL_REFRESH_MS);
setInterval(updateDisplaySchedule, 60 * 1000);
