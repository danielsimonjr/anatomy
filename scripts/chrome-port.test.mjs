import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromeCandidates, chromePath, chromePort, portOf, stopChrome } from "./chrome-port.mjs";

function fakeChrome() {
  const chrome = new EventEmitter();
  chrome.stderr = new EventEmitter();
  chrome.signals = [];
  chrome.kill = (signal) => chrome.signals.push(signal);
  return chrome;
}

function profileDir() {
  return mkdtempSync(join(tmpdir(), "anatomy-chrome-port-"));
}

test("the port comes from the profile when the launcher exits 0 and prints nothing", async () => {
  const profile = profileDir();
  try {
    const chrome = fakeChrome();
    setTimeout(() => chrome.emit("exit", 0, null), 20);
    setTimeout(() => writeFileSync(join(profile, "DevToolsActivePort"), "9222\n/devtools/browser/abc\n"), 120);
    assert.equal(await chromePort(chrome, profile), 9222);
    assert.deepEqual(chrome.signals, []);
    assert.ok(existsSync(profile));
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("the port comes from the DevTools line on stderr", async () => {
  const profile = profileDir();
  try {
    const chrome = fakeChrome();
    setTimeout(() => chrome.stderr.emit("data", "DevTools listening on ws://127.0.0.1:4455/devtools/browser/abc\n"), 20);
    assert.equal(await chromePort(chrome, profile), 4455);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("a non-zero exit fails at once, kills the child and removes the profile", async () => {
  const profile = profileDir();
  try {
    const chrome = fakeChrome();
    setTimeout(() => chrome.emit("exit", 7, null), 20);
    await assert.rejects(chromePort(chrome, profile), /Chrome exited before startup: 7/);
    assert.deepEqual(chrome.signals, ["SIGKILL"]);
    assert.equal(existsSync(profile), false);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("an exit 0 with no port file fails at the timeout and removes the profile", async () => {
  const profile = profileDir();
  try {
    const chrome = fakeChrome();
    setTimeout(() => chrome.emit("exit", 0, null), 20);
    await assert.rejects(chromePort(chrome, profile, { timeoutMs: 300 }), /Chrome did not start/);
    assert.equal(existsSync(profile), false);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("portOf reads a number on line one and nothing else", async () => {
  const profile = profileDir();
  try {
    assert.equal(portOf(profile), null);
    writeFileSync(join(profile, "DevToolsActivePort"), "not a port\n");
    assert.equal(portOf(profile), null);
    writeFileSync(join(profile, "DevToolsActivePort"), "51234\n/devtools/browser/x");
    assert.equal(portOf(profile), 51234);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("stopChrome kills the child and removes the profile when no browser listens", async () => {
  const profile = profileDir();
  try {
    const chrome = fakeChrome();
    const started = performance.now();
    await stopChrome(chrome, profile, 1);
    assert.deepEqual(chrome.signals, ["SIGKILL"]);
    assert.equal(existsSync(profile), false);
    assert.ok(performance.now() - started < 5000);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("CHROME_PATH is tried first and the Windows roots come from the environment", () => {
  const env = { CHROME_PATH: "/opt/chrome", PROGRAMFILES: "P:/Program Files", "PROGRAMFILES(X86)": "P:/Program Files (x86)", LOCALAPPDATA: "P:/Local" };
  const list = chromeCandidates(env, "/nowhere").map((path) => path.replaceAll("\\", "/"));
  assert.equal(list[0], "/opt/chrome");
  assert.ok(list.includes("P:/Program Files/Google/Chrome/Application/chrome.exe"));
  assert.ok(list.includes("P:/Program Files (x86)/Google/Chrome/Application/chrome.exe"));
  assert.ok(list.includes("P:/Local/Google/Chrome/Application/chrome.exe"));
  assert.ok(list.indexOf("P:/Program Files/Google/Chrome/Application/chrome.exe") < list.indexOf("P:/Program Files/Microsoft/Edge/Application/msedge.exe"));
});

test("the Chromium that Playwright caches on Windows is a candidate, newest first", async () => {
  const local = mkdtempSync(join(tmpdir(), "anatomy-chrome-path-"));
  try {
    const exe = join(local, "ms-playwright", "chromium-1243", "chrome-win64", "chrome.exe");
    mkdirSync(join(local, "ms-playwright", "chromium-1243", "chrome-win64"), { recursive: true });
    mkdirSync(join(local, "ms-playwright", "chromium-1234", "chrome-win64"), { recursive: true });
    writeFileSync(exe, "");
    const list = chromeCandidates({ LOCALAPPDATA: local }, join(local, "home"));
    const first = list.findIndex((path) => path.includes("chromium-1243"));
    const second = list.findIndex((path) => path.includes("chromium-1234"));
    assert.ok(first >= 0 && first < second);
    assert.equal(chromePath({ LOCALAPPDATA: local }, join(local, "home")), exe);
  } finally {
    await rm(local, { recursive: true, force: true });
  }
});

test("chromePath never returns a path that does not exist", () => {
  const found = chromePath({ CHROME_PATH: join(tmpdir(), "anatomy-no-such-chrome") }, join(tmpdir(), "anatomy-no-such-home"));
  assert.ok(found === undefined || existsSync(found));
  assert.notEqual(found, join(tmpdir(), "anatomy-no-such-chrome"));
});
