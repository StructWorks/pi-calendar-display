"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function writeTempConfig(port) {
  const cfg = {
    google: { clientId: "test", clientSecret: "test", redirectUri: "http://localhost/cb" },
    calendars: [],
    weather: { latitude: 0, longitude: 0, locationName: "T", timezone: "UTC" },
    server: { port, calendarRefreshSeconds: 9999, weatherRefreshSeconds: 9999 },
    allDayLocationKeywords: [],
    display: {
      brightness: { method: "software", transitionMinutes: 0, schedule: [{ from: "00:00", level: 80 }] },
      view: { schedule: [{ from: "00:00", mode: "full" }] },
    },
    remote: { enabled: true, backgrounds: ["bg.jpg", "bg2.jpg"], screenPower: { off: "", on: "" } },
  };
  const p = path.join(os.tmpdir(), `pcd-test-config-${port}.json`);
  fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

async function waitForServer(base, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + "/api/data");
      if (res.ok) return;
    } catch {
      // まだ起動していない。
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not start in time");
}

async function cmd(base, body) {
  const res = await fetch(base + "/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

test("server endpoints", async (t) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const configPath = writeTempConfig(port);
  const tokenPath = path.join(os.tmpdir(), `pcd-test-token-${port}.json`);

  // PCD_ENV/PCD_STATE を実在しないパスにして、開発機の .env / state.json を拾わずテストを隔離する。
  const envPath = path.join(os.tmpdir(), `pcd-test-noenv-${port}`);
  const statePath = path.join(os.tmpdir(), `pcd-test-state-${port}.json`);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PCD_CONFIG: configPath,
      PCD_TOKEN: tokenPath,
      PCD_ENV: envPath,
      PCD_STATE: statePath,
    },
    stdio: "ignore",
  });

  const uploaded = []; // アップロードで作られた public/ のファイルを後始末する
  t.after(() => {
    child.kill("SIGKILL");
    fs.rmSync(configPath, { force: true });
    fs.rmSync(tokenPath, { force: true });
    fs.rmSync(statePath, { force: true });
    for (const f of uploaded) fs.rmSync(f, { force: true });
  });

  await waitForServer(base);

  await t.test("/api/data はキャッシュ形状を返す", async () => {
    const res = await fetch(base + "/api/data");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const d = await res.json();
    for (const k of ["today", "tomorrow", "allDay", "location", "display"]) {
      assert.ok(k in d, `key ${k} がある`);
    }
    assert.equal(d.display.brightness, 80); // schedule level
    assert.equal(d.display.view, "full");
  });

  await t.test("setView は許可リスト外を 400 で拒否（XSS対策）", async () => {
    const bad = await cmd(base, { action: "setView", value: "<img src=x onerror=alert(1)>" });
    assert.equal(bad.status, 400);
    const ok = await cmd(base, { action: "setView", value: "night" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.display.view, "night");
  });

  await t.test("setBackground は許可リスト外を拒否、リスト内は受理", async () => {
    const bad = await cmd(base, { action: "setBackground", value: "../../etc/passwd" });
    assert.equal(bad.status, 400);
    const ok = await cmd(base, { action: "setBackground", value: "bg2.jpg" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.display.background, "bg2.jpg");
  });

  await t.test("nextBackground は循環する", async () => {
    await cmd(base, { action: "setBackground", value: "bg.jpg" });
    const n = await cmd(base, { action: "nextBackground" });
    assert.equal(n.json.display.background, "bg2.jpg");
    const n2 = await cmd(base, { action: "nextBackground" });
    assert.equal(n2.json.display.background, "bg.jpg"); // 末尾→先頭
  });

  await t.test("setBrightness は範囲検証し override を立てる", async () => {
    const bad = await cmd(base, { action: "setBrightness", value: 999 });
    assert.equal(bad.status, 400);
    const ok = await cmd(base, { action: "setBrightness", value: 30 });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.display.brightness, 30);
    assert.equal(ok.json.display.brightnessOverride, 30);
    const cl = await cmd(base, { action: "clearBrightness" });
    assert.equal(cl.json.display.brightnessOverride, null);
    assert.equal(cl.json.display.brightness, 80); // スケジュールへ復帰
  });

  await t.test("未知 action は 400", async () => {
    const r = await cmd(base, { action: "definitelyNotAnAction" });
    assert.equal(r.status, 400);
  });

  await t.test("setNightWindow は HH:MM を検証し display.night に反映", async () => {
    const bad = await cmd(base, { action: "setNightWindow", value: { from: "25:00" } });
    assert.equal(bad.status, 400);
    const ok = await cmd(base, {
      action: "setNightWindow",
      value: { enabled: true, from: "22:30", to: "07:00" },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.display.night, {
      enabled: true,
      from: "22:30",
      to: "07:00",
    });
    // /api/data にも反映
    const data = await (await fetch(base + "/api/data")).json();
    assert.equal(data.display.night.from, "22:30");
  });

  await t.test("別オリジンからの /api/command は 403（CSRF対策）", async () => {
    const res = await fetch(base + "/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ action: "resync" }),
    });
    assert.equal(res.status, 403);
  });

  await t.test("同一オリジン（Origin=Host）の /api/command は許可", async () => {
    const res = await fetch(base + "/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ action: "resync" }),
    });
    assert.equal(res.status, 200);
  });

  await t.test("/api/background は画像を受理し背景を切替、非画像を拒否", async () => {
    // 非画像（テキスト）は 400
    const bad = await fetch(base + "/api/background", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not an image",
    });
    assert.equal(bad.status, 400);

    // PNG シグネチャ付きバッファは受理
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
    ]);
    const ok = await fetch(base + "/api/background", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: png,
    });
    assert.equal(ok.status, 200);
    const data = await ok.json();
    assert.match(data.display.background, /^bg-upload-\d+\.png$/);
    assert.ok(data.backgrounds.includes(data.display.background));
    uploaded.push(path.join(ROOT, "public", data.display.background));
    // 保存されたファイルが実在する
    assert.ok(fs.existsSync(path.join(ROOT, "public", data.display.background)));
  });

  await t.test("/remote と / が配信される", async () => {
    assert.equal((await fetch(base + "/remote")).status, 200);
    assert.equal((await fetch(base + "/")).status, 200);
  });
});
