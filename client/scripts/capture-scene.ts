#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const values = Object.fromEntries(
  process.argv.slice(2).map((item) => {
    const [key, ...rest] = item.replace(/^--/, "").split("=");
    return [key, rest.join("=")];
  }),
);
const url = values.url;
const output = values.out;
const width = Number(values.width ?? 1440);
const height = Number(values.height ?? 900);
const dpr = Number(values.dpr ?? 1);
if (!url || !output || ![1, 2].includes(dpr))
  throw new Error(
    "Usage: capture-scene --url=<fixture URL> --out=<repo PNG> [--width=1440 --height=900 --dpr=1]",
  );

const repo = resolve(import.meta.dir, "../..");
const chrome =
  process.env.QE_CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outPath = resolve(repo, output);
const scratch = resolve(repo, `.pi/tmp/visual-capture-${process.pid}`);
await mkdir(dirname(outPath), { recursive: true });
await mkdir(scratch, { recursive: true });

interface CdpPage {
  webSocketDebuggerUrl: string;
  url: string;
}
interface CdpResponse {
  id?: number;
  result?: {
    data?: string;
    result?: { value?: unknown };
  };
}
interface CanvasCapture {
  data: string;
  rect: { width: number; height: number };
}
class Cdp {
  private id = 0;
  private pending = new Map<number, (value: CdpResponse) => void>();
  private constructor(private socket: WebSocket) {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse;
      if (!message.id) return;
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    };
  }
  static async connect(port: number) {
    const pages = (await fetch(`http://127.0.0.1:${port}/json/list`).then(
      (response) => response.json(),
    )) as CdpPage[];
    const page =
      pages.find((value) => value.url.includes("127.0.0.1:1420")) ?? pages[0];
    if (!page) throw new Error("Chrome did not expose a page target.");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = reject;
    });
    return new Cdp(socket);
  }
  send(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<CdpResponse>((resolve) => this.pending.set(id, resolve));
  }
  close() {
    this.socket.close();
  }
}

async function waitForChrome(port: number) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch {
      /* startup */
    }
    await Bun.sleep(100);
  }
  throw new Error("Chrome DevTools did not start.");
}

function launch(pageUrl: string, port: number, name: string, webgl: boolean) {
  const args = [
    "--headless=new",
    "--no-first-run",
    "--disable-background-networking",
    "--disable-component-update",
    `--force-device-scale-factor=${dpr}`,
    `--window-size=${width},${height + 87}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${resolve(scratch, name)}`,
  ];
  if (webgl)
    args.push("--use-angle=swiftshader", "--enable-unsafe-swiftshader");
  args.push(pageUrl);
  return Bun.spawn([chrome, ...args], { stdout: "ignore", stderr: "ignore" });
}

async function captureWorld(port: number, path: string) {
  const process = launch(url, port, "world", true);
  try {
    await waitForChrome(port);
    await Bun.sleep(6000);
    const cdp = await Cdp.connect(port);
    await cdp.send("Runtime.enable");
    const response = await cdp.send("Runtime.evaluate", {
      expression: `(()=>{const c=document.querySelector('canvas');return {data:c.toDataURL('image/png'),rect:c.getBoundingClientRect().toJSON()}})()`,
      returnByValue: true,
    });
    const value = response.result?.result?.value as CanvasCapture | undefined;
    if (!value?.data)
      throw new Error("Pixi canvas was not available for capture.");
    if (
      Math.round(value.rect.width) !== width ||
      Math.round(value.rect.height) !== height
    )
      throw new Error(
        `Unexpected CSS viewport ${value.rect.width}×${value.rect.height}; expected ${width}×${height}.`,
      );
    const encoded = value.data.split(",")[1];
    if (!encoded) throw new Error("Pixi canvas data URL was invalid.");
    await Bun.write(path, Buffer.from(encoded, "base64"));
    cdp.close();
  } finally {
    process.kill();
  }
}

async function captureDom(port: number, path: string) {
  const domUrl = new URL(url);
  domUrl.searchParams.set("capture", "dom");
  const process = launch(domUrl.toString(), port, "dom", false);
  try {
    await waitForChrome(port);
    await Bun.sleep(2500);
    const cdp = await Cdp.connect(port);
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    const response = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      omitBackground: true,
    });
    const data = response.result?.data;
    if (!data) throw new Error("DOM screenshot was not returned by Chrome.");
    await Bun.write(path, Buffer.from(data, "base64"));
    cdp.close();
  } finally {
    process.kill();
  }
}

const basePort = 15000 + (process.pid % 10000) * 2;
const worldPath = resolve(scratch, "world.png");
const domPath = resolve(scratch, "dom.png");
await captureWorld(basePort, worldPath);
await captureDom(basePort + 1, domPath);
const composite = Bun.spawn(
  [
    "python3",
    resolve(repo, "client/scripts/composite-png.py"),
    worldPath,
    domPath,
    outPath,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await composite.exited) !== 0)
  throw new Error("Screenshot compositing failed.");
console.log(`${width}×${height}@${dpr} ${output}`);
