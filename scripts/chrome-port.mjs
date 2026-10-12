import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STARTUP_TIMEOUT_MS = 20000;
const POLL_MS = 50;
const CLOSE_TIMEOUT_MS = 5000;

const PLAYWRIGHT_BINARIES = [
  ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
  ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ["chrome-linux", "chrome"],
  ["chrome-win64", "chrome.exe"],
  ["chrome-win", "chrome.exe"],
];

/**
 * The places a Chrome or Chromium binary can be, in the order they are tried: the
 * `CHROME_PATH` variable, the system Chrome on macOS, Linux and Windows, the Chromium
 * that Playwright caches, and last the Edge that every Windows machine has.
 */
export function chromeCandidates(env = process.env, home = homedir()) {
  const windowsRoots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
  const candidates = [
    env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    ...windowsRoots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe")),
  ];
  const caches = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    join(home, "Library", "Caches", "ms-playwright"),
    join(home, ".cache", "ms-playwright"),
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "ms-playwright") : null,
  ].filter(Boolean);
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    for (const dir of readdirSync(cache).sort().reverse()) {
      for (const parts of PLAYWRIGHT_BINARIES) candidates.push(join(cache, dir, ...parts));
    }
  }
  for (const root of windowsRoots) candidates.push(join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
  return candidates.filter(Boolean);
}

/** The first Chrome or Chromium binary that exists, or undefined when none does. */
export function chromePath(env = process.env, home = homedir()) {
  return chromeCandidates(env, home).find((path) => existsSync(path));
}

/**
 * Read the DevTools port that a running Chrome wrote into its profile folder.
 * Chrome writes `DevToolsActivePort` (the port on line one) on every platform.
 * Returns null while the file is missing or not yet complete.
 */
export function portOf(profile) {
  try {
    const port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Remove a throwaway profile. Chrome's helper processes can hold the folder for about a
 * second after the browser closes, and Windows then refuses the removal (EPERM, EBUSY).
 * Measured: the folder is free about 1 s later. So the removal is tried again every 100 ms
 * for 4 s, and a folder that is still held after that is left for the system to clean.
 */
export async function removeProfile(profile) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      rmSync(profile, { recursive: true, force: true });
      return;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
}

/**
 * Wait until Chrome serves DevTools and return its port.
 *
 * Two signals report the port: the `DevTools listening` line on stderr (macOS and Linux
 * print it) and the `DevToolsActivePort` file in the profile (every platform writes it).
 * On Windows the stderr line does not arrive, and `--headless=new` can make the process
 * that `spawn` returned exit 0 while the browser it started keeps running. So an exit
 * code of 0 is not a failure: the wait goes on until the port file appears. A non-zero
 * exit or a signal fails at once, and so does a spawn error.
 *
 * On failure the child is killed and the profile is removed.
 */
export async function chromePort(chrome, profile, { timeoutMs = STARTUP_TIMEOUT_MS } = {}) {
  try {
    return await new Promise((done, fail) => {
      let text = "";
      let timer;
      let poll;
      const clean = () => {
        clearTimeout(timer);
        clearInterval(poll);
        chrome.stderr.off("data", data);
        chrome.off("error", error);
        chrome.off("exit", exited);
      };
      const error = (cause) => {
        clean();
        fail(cause);
      };
      const exited = (code, signal) => {
        if (code === 0) return;
        error(new Error(`Chrome exited before startup: ${code ?? signal}`));
      };
      const data = (chunk) => {
        text += chunk;
        const match = text.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
        if (match) {
          clean();
          done(Number(match[1]));
        }
      };
      timer = setTimeout(() => error(new Error("Chrome did not start")), timeoutMs);
      poll = setInterval(() => {
        const port = portOf(profile);
        if (port !== null) {
          clean();
          done(port);
        }
      }, POLL_MS);
      chrome.stderr.on("data", data);
      chrome.on("error", error);
      chrome.on("exit", exited);
    });
  } catch (error) {
    chrome.kill("SIGKILL");
    await removeProfile(profile);
    throw error;
  }
}

/**
 * End the script with an exit code.
 *
 * `process.exit` while a socket or fetch handle is still closing aborts Node on Windows
 * (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) and replaces the exit code with
 * 127. So the code is set and the event loop drains by itself. The timer is a fallback for a
 * handle that never closes: it does not hold the loop open.
 */
export function leave(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2000).unref();
}

/**
 * Stop the browser that `chromePort` found.
 *
 * The child that `spawn` returned can be gone while the browser still runs, so killing
 * it is not enough. The browser is asked to close over DevTools (`Browser.close`), the
 * port is watched until it stops answering, then the child is killed and the profile is
 * removed. Every step tolerates a browser that is already gone.
 */
export async function stopChrome(chrome, profile, port) {
  const url = `http://127.0.0.1:${port}/json/version`;
  try {
    const info = await (await fetch(url, { signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) })).json();
    await new Promise((done) => {
      const socket = new WebSocket(info.webSocketDebuggerUrl);
      const timer = setTimeout(done, CLOSE_TIMEOUT_MS);
      const end = () => {
        clearTimeout(timer);
        done();
      };
      socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" })));
      socket.addEventListener("close", end);
      socket.addEventListener("error", end);
    });
    const deadline = Date.now() + CLOSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(500) });
      } catch {
        break;
      }
      await new Promise((done) => setTimeout(done, POLL_MS));
    }
  } catch {}
  chrome.kill("SIGKILL");
  await removeProfile(profile);
}
