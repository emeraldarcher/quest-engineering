#!/usr/bin/env bun
/** Render the generated reference map with standard Tiled GID semantics. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const clientRoot = resolve(import.meta.dir, "..");
const mapPath = resolve(
  clientRoot,
  "src/world/maps/reference/sunnyside-example-world.tmj",
);
const originalPath =
  process.env.SUNNYSIDE_EXAMPLE_IMAGE ??
  resolve(
    process.env.HOME ?? "~",
    "Downloads/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Assets/Sunnyside_World_ExampleScene.png",
  );
const output = resolve(
  clientRoot,
  "../docs/screenshots/reference/sunnyside-example-world-side-by-side.png",
);
const chrome =
  process.env.QE_CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(mapPath))
  throw new Error(`Missing generated reference map: ${mapPath}`);
if (!existsSync(originalPath))
  throw new Error(`Missing bundled Sunnyside example image: ${originalPath}`);

const [map, world, forest, objects] = await Promise.all([
  readFile(mapPath, "utf8"),
  readFile(
    resolve(clientRoot, "src/world/maps/tilesets/sunnyside-world.tsj"),
    "utf8",
  ),
  readFile(
    resolve(clientRoot, "src/world/maps/tilesets/sunnyside-forest.tsj"),
    "utf8",
  ),
  readFile(
    resolve(clientRoot, "src/world/maps/tilesets/sunnyside-objects.tsj"),
    "utf8",
  ),
]);
const payload = JSON.stringify({
  map: JSON.parse(map),
  world: JSON.parse(world),
  forest: JSON.parse(forest),
  objects: JSON.parse(objects),
}).replace(/</g, "\\u003c");

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const images: Record<string, string> = {
      "/world.png": resolve(
        clientRoot,
        "src/assets/sunnyside/terrain/world-16px.png",
      ),
      "/forest.png": resolve(
        clientRoot,
        "src/assets/sunnyside/terrain/forest-32px.png",
      ),
      "/original.png": originalPath,
    };
    if (path.startsWith("/reference/")) {
      images[path] = resolve(
        clientRoot,
        "src/assets/sunnyside/reference/sunnyside-example",
        path.slice("/reference/".length),
      );
    }
    const image = images[path];
    if (image && existsSync(image)) return new Response(Bun.file(image));
    if (path !== "/") return new Response("Not found", { status: 404 });
    return new Response(
      `<!doctype html><style>html,body{margin:0;padding:0;overflow:hidden}</style><canvas id="comparison"></canvas><script>
const source = ${payload};
const H=0x80000000,V=0x40000000,D=0x20000000, MASK=0x1fffffff;
const images = new Map();
function image(url) { const value=new Image(); value.src=url; return new Promise((ok,bad)=>{value.onload=()=>ok(value);value.onerror=bad;}); }
function sourceFor(tile) { return tile.image ? '/reference/'+tile.image.split('/').pop() : null; }
function transform(ctx, gid, x, y, width, height) {
  const h=(gid&H)!==0,v=(gid&V)!==0,d=(gid&D)!==0;
  ctx.translate(x+width/2,y+height/2);
  if(d) ctx.transform(0,1,1,0,0,0);
  if(h) ctx.scale(-1,1); if(v) ctx.scale(1,-1);
  ctx.translate(-width/2,-height/2);
}
async function draw() {
 const map=source.map, tilesets=[source.world,source.forest,source.objects];
 const urls=['/world.png','/forest.png',...source.objects.tiles.filter(t=>t.id>=22).map(sourceFor),'/original.png'];
 await Promise.all(urls.map(async url=>images.set(url,await image(url))));
 const converted=document.createElement('canvas'); converted.width=map.width*16; converted.height=map.height*16;
 const ctx=converted.getContext('2d'); ctx.imageSmoothingEnabled=false;
 const ranges=map.tilesets.map((ref,i)=>({first:ref.firstgid,last:(map.tilesets[i+1]?.firstgid??Infinity)-1,tileset:tilesets[i]}));
 function tile(gid) { const id=gid&MASK; return ranges.find(range=>id>=range.first&&id<=range.last); }
 for(const layer of map.layers) {
  if(!layer.visible) continue;
  if(layer.type==='tilelayer') for(let cell=0;cell<layer.data.length;cell++) { const gid=layer.data[cell];if(!gid)continue; const range=tile(gid), set=range.tileset, local=(gid&MASK)-range.first;const tw=set.tilewidth,th=set.tileheight; const x=(cell%map.width)*16,y=Math.floor(cell/map.width)*16;
   ctx.save(); transform(ctx,gid,x,y,tw,th); ctx.drawImage(images.get(set===source.world?'/world.png':'/forest.png'),(local%set.columns)*tw,Math.floor(local/set.columns)*th,tw,th,-tw/2,-th/2,tw,th);ctx.restore(); }
  if(layer.type==='objectgroup') for(const object of layer.objects) { if(!object.visible||!object.gid)continue;const range=tile(object.gid),local=(object.gid&MASK)-range.first,def=range.tileset.tiles.find(item=>item.id===local);if(!def)continue; const image=images.get(sourceFor(def));ctx.save();ctx.translate(object.x,object.y-object.height);ctx.rotate(object.rotation*Math.PI/180);transform(ctx,object.gid,0,0,object.width,object.height);ctx.drawImage(image,0,0,object.width,object.height);ctx.restore(); }
 }
 const original=images.get('/original.png'); const originalHeight=converted.height, originalWidth=Math.round(original.width*originalHeight/original.height); const canvas=document.querySelector('canvas'); canvas.width=converted.width+8+originalWidth;canvas.height=originalHeight; const out=canvas.getContext('2d');out.imageSmoothingEnabled=false;out.drawImage(converted,0,0);out.fillStyle='#2b3738';out.fillRect(converted.width,0,8,originalHeight);out.drawImage(original,converted.width+8,0,originalWidth,originalHeight); document.title='ready';
}
draw().catch((error)=>{document.title='error: '+error.message; console.error(error);});
</script>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});

const scratch = resolve(
  clientRoot,
  `../.pi/tmp/sunnyside-reference-render-${process.pid}`,
);
const chromeProcess = Bun.spawn(
  [
    chrome,
    "--headless=new",
    "--no-first-run",
    "--disable-background-networking",
    "--window-size=2800,800",
    "--remote-debugging-port=19222",
    `--user-data-dir=${scratch}`,
    `http://127.0.0.1:${server.port}`,
  ],
  { stdout: "ignore", stderr: "ignore" },
);
try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await Bun.sleep(100);
    try {
      const pages = (await fetch("http://127.0.0.1:19222/json/list").then(
        (response) => response.json(),
      )) as { url: string; webSocketDebuggerUrl: string }[];
      const page = pages.find(
        (candidate) => candidate.url === `http://127.0.0.1:${server.port}/`,
      );
      if (!page) throw new Error("Renderer page is not available in Chrome");
      const socket = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise<void>((ok, bad) => {
        const timeout = setTimeout(
          () => bad(new Error("CDP socket timeout")),
          1000,
        );
        socket.onopen = () => {
          clearTimeout(timeout);
          ok();
        };
        socket.onerror = () => {
          clearTimeout(timeout);
          bad(new Error("CDP socket error"));
        };
      });
      let id = 0;
      const send = (method: string, params: Record<string, unknown> = {}) =>
        new Promise<{
          result?: { data?: string; result?: { value?: unknown } };
        }>((ok) => {
          const requestId = ++id;
          socket.send(JSON.stringify({ id: requestId, method, params }));
          socket.onmessage = (event) => {
            const result = JSON.parse(String(event.data)) as {
              id?: number;
              result?: { data?: string; result?: { value?: unknown } };
            };
            if (result.id === requestId) ok(result);
          };
        });
      const title = await send("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      });
      const state = title.result?.result?.value as string;
      if (state.startsWith("error:")) throw new Error(state);
      if (state !== "ready") {
        socket.close();
        if (attempt === 99)
          throw new Error(
            `Renderer did not become ready (state: ${state || "empty"})`,
          );
        continue;
      }
      const screenshot = await send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
      });
      const data = screenshot.result?.data;
      if (!data)
        throw new Error("Chrome did not return the comparison screenshot");
      await Bun.write(output, Buffer.from(data, "base64"));
      socket.close();
      console.log(`Rendered ${output}`);
      break;
    } catch (error) {
      if (attempt === 99) console.error(error);
    }
    if (attempt === 99)
      throw new Error("Timed out rendering Sunnyside reference comparison");
  }
} finally {
  chromeProcess.kill();
  server.stop();
}
