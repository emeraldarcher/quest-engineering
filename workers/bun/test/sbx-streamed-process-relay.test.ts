import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface Frame {
  type: number;
  payload: Uint8Array;
}

test("guest relay launches the target with only explicitly named environment entries", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "sbx-relay-environment-"));
  try {
    const marker = join(root, "marker.json");
    await writeFile(marker, "{}", { mode: 0o600 });
    const source = (
      await readFile(
        join(
          process.cwd(),
          "src",
          "execution-environment",
          "sbx-streamed-process-relay.py",
        ),
        "utf8",
      )
    )
      .replace(
        'observed = os.readlink(f"/proc/{process.pid}/exe")',
        "observed = target_argv[0]",
      )
      .replace(
        "started = start_identity(process.pid)",
        'started = "portable-test-identity"',
      )
      .replace("    stdin_thread.start()", "    # portable unit test");
    const names = Buffer.from(JSON.stringify(["EXPLICIT_ALLOWED"])).toString(
      "base64",
    );
    const target = [
      "/usr/bin/python3",
      "-c",
      "import json,os,time;print(json.dumps({'allowed':os.environ.get('EXPLICIT_ALLOWED')=='bounded','anthropic_api_key':'ANTHROPIC_API_KEY' in os.environ,'anthropic_auth_token':'ANTHROPIC_AUTH_TOKEN' in os.environ,'aws':'AWS_ACCESS_KEY_ID' in os.environ,'host_only':'QE_RELAY_HOST_ONLY' in os.environ},separators=(',',':')));time.sleep(0.1)",
    ];
    const child = Bun.spawn(
      [
        "/usr/bin/python3",
        "-u",
        "-c",
        source,
        marker,
        "--environment-names-base64",
        names,
        "--process-generation",
        "11111111-1111-4111-8111-111111111111",
        "--",
        ...target,
      ],
      {
        env: {
          ...process.env,
          EXPLICIT_ALLOWED: "bounded",
          ANTHROPIC_API_KEY: "must-not-reach-target",
          ANTHROPIC_AUTH_TOKEN: "must-not-reach-target",
          AWS_ACCESS_KEY_ID: "must-not-reach-target",
          QE_RELAY_HOST_ONLY: "must-not-reach-target",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const bytes = new Uint8Array(
      await new Response(child.stdout).arrayBuffer(),
    );
    const frames = decodeFrames(bytes);
    expect({
      exitCode: await child.exited,
      frames: frames.map((frame) => ({
        type: frame.type,
        payload: new TextDecoder().decode(frame.payload),
      })),
    }).toMatchObject({ exitCode: 0 });
    expect(frames[0]?.type).toBe(1);
    const stdout = frames
      .filter((frame) => frame.type === 2)
      .map((frame) => new TextDecoder().decode(frame.payload))
      .join("");
    expect(JSON.parse(stdout)).toEqual({
      allowed: true,
      anthropic_api_key: false,
      anthropic_auth_token: false,
      aws: false,
      host_only: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guest relay emits a short non-newline prompt before the target receives input", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "sbx-relay-short-prompt-"));
  try {
    const marker = join(root, "marker.json");
    await writeFile(marker, "{}", { mode: 0o600 });
    const source = (
      await readFile(
        join(
          process.cwd(),
          "src",
          "execution-environment",
          "sbx-streamed-process-relay.py",
        ),
        "utf8",
      )
    )
      .replace(
        'observed = os.readlink(f"/proc/{process.pid}/exe")',
        "observed = target_argv[0]",
      )
      .replace(
        "started = start_identity(process.pid)",
        'started = "portable-test-identity"',
      );
    const child = Bun.spawn(
      [
        "/usr/bin/python3",
        "-u",
        "-c",
        source,
        marker,
        "--environment-names-base64",
        Buffer.from("[]").toString("base64"),
        "--process-generation",
        "11111111-1111-4111-8111-111111111111",
        "--",
        "/usr/bin/python3",
        "-u",
        "-c",
        "import sys;sys.stdout.write('short prompt > ');sys.stdout.flush();sys.stdin.readline()",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const frames = frameReader(child.stdout.getReader());
    expect((await frames.next()).type).toBe(1);
    const prompt = await Promise.race([
      frames.next(),
      Bun.sleep(500).then(() => {
        throw new Error("short prompt remained buffered");
      }),
    ]);
    expect(prompt.type).toBe(2);
    expect(new TextDecoder().decode(prompt.payload)).toBe("short prompt > ");
    child.stdin.write(encodeFrame(5, new TextEncoder().encode("ok\n")));
    child.stdin.flush();
    expect(await child.exited).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guest relay distinguishes target spawn rejection from post-spawn ambiguity", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "sbx-relay-rejection-"));
  try {
    const marker = join(root, "marker.json");
    await writeFile(marker, "{}", { mode: 0o600 });
    const source = await readFile(
      join(
        process.cwd(),
        "src",
        "execution-environment",
        "sbx-streamed-process-relay.py",
      ),
      "utf8",
    );
    const child = Bun.spawn(
      [
        "/usr/bin/python3",
        "-u",
        "-c",
        source,
        marker,
        "--environment-names-base64",
        Buffer.from("[]").toString("base64"),
        "--process-generation",
        "11111111-1111-4111-8111-111111111111",
        "--",
        "/does/not/exist",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const frames = decodeFrames(
      new Uint8Array(await new Response(child.stdout).arrayBuffer()),
    );
    expect(await child.exited).toBe(126);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe(12);
    expect(JSON.parse(new TextDecoder().decode(frames[0]?.payload))).toEqual({
      code: "spawn_not_started",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function frameReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let buffered = new Uint8Array();
  return {
    async next(): Promise<Frame> {
      while (true) {
        if (buffered.byteLength >= 5) {
          const view = new DataView(
            buffered.buffer,
            buffered.byteOffset,
            buffered.byteLength,
          );
          const size = view.getUint32(1, false);
          if (buffered.byteLength >= size + 5) {
            const frame = {
              type: view.getUint8(0),
              payload: buffered.slice(5, size + 5),
            };
            buffered = buffered.slice(size + 5);
            return frame;
          }
        }
        const value = await reader.read();
        if (value.done) throw new Error("relay stream ended before next frame");
        const next = new Uint8Array(
          buffered.byteLength + value.value.byteLength,
        );
        next.set(buffered);
        next.set(value.value, buffered.byteLength);
        buffered = next;
      }
    },
  };
}

function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, type);
  view.setUint32(1, payload.byteLength, false);
  frame.set(payload, 5);
  return frame;
}

function decodeFrames(bytes: Uint8Array): Frame[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: Frame[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 5 > bytes.length) throw new Error("truncated relay frame");
    const type = view.getUint8(offset);
    const size = view.getUint32(offset + 1, false);
    offset += 5;
    if (offset + size > bytes.length)
      throw new Error("truncated relay payload");
    frames.push({ type, payload: bytes.slice(offset, offset + size) });
    offset += size;
  }
  return frames;
}
