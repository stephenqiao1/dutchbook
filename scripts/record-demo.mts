/* eslint-disable unicorn/prefer-add-event-listener --
 * Node's WebSocket is used here exactly as the DevTools protocol examples do:
 * one handler for one socket, assigned once. `addEventListener` buys nothing
 * and costs the narrow types on `ws.onmessage`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Records the dashboard demo in `docs/img/`.
 *
 *   pnpm demo                      # against http://127.0.0.1:3000
 *   pnpm demo --url=http://…:3111
 *
 * Needs a running dashboard, Chrome, and ffmpeg.
 *
 * Produces a GIF and an MP4 from the same frames. Both, because they are for
 * different places: GitHub will not play a relative-path `<video>` in a README,
 * so the inline demo has to be a GIF — and a GIF of a 25-second screen recording
 * is an order of magnitude larger than the equivalent MP4, so the MP4 is kept
 * for anywhere that can actually play one.
 *
 * Frames come from the DevTools screencast, which only emits when the page
 * changes. That is why the durations come from each frame's own timestamp
 * rather than from a fixed frame rate: a five-second pause on one view is one
 * frame held for five seconds, not fifty identical frames.
 */

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k ?? '', v ?? 'true'];
  }),
);

const target = args.get('url') ?? 'http://127.0.0.1:3000';
const outDir = args.get('out') ?? 'docs/img';
const port = 9333;

/**
 * The two families the tour opens.
 *
 * Chosen because they are actually violated: a partition whose ten prices sum
 * past 1.00, and a ladder priced above what it entails. A demo of a coherent
 * family would show the feature working and the point not landing.
 */
const PARTITION = args.get('partition') ?? 'group:23109';
const LADDER = args.get('ladder') ?? 'event:259356';

const CHROME =
  process.env['CHROME_PATH'] ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const frameDir = join('/tmp', `dutchbook-demo-${process.pid}`);
mkdirSync(frameDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const chrome = spawn(
  CHROME,
  ['--headless', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, 'about:blank'],
  { stdio: 'ignore' },
);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ffmpeg = (a: string[]): void => {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' });
};

const sizeOf = (path: string): string => {
  const bytes = statSync(path).size;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

async function connect(): Promise<WebSocket> {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      const page = list.find((t) => t.type === 'page');
      if (page !== undefined) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => {
          ws.onopen = () => r(null);
        });
        return ws;
      }
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error('could not attach to Chrome');
}

const ws = await connect();

let id = 0;
const pending = new Map<number, (v: unknown) => void>();
const frames: { file: string; at: number }[] = [];

const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve as (v: unknown) => void);
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data)) as {
    id?: number;
    method?: string;
    result?: Record<string, unknown>;
    params?: Record<string, unknown>;
  };

  if (typeof message.id === 'number') {
    pending.get(message.id)?.(message.result ?? {});
    pending.delete(message.id);
    return;
  }

  if (message.method === 'Page.screencastFrame') {
    const p = message.params as { data: string; sessionId: number; metadata: { timestamp: number } };
    const file = join(frameDir, `f${String(frames.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(p.data, 'base64'));
    frames.push({ file, at: p.metadata.timestamp });
    void send('Page.screencastFrameAck', { sessionId: p.sessionId });
  }
};

const evaluate = (expression: string): Promise<Record<string, unknown>> =>
  send('Runtime.evaluate', { expression, returnByValue: true });

/**
 * Navigates the SPA and holds still long enough to read the result.
 *
 * The hold starts once the view has actually rendered, not when the hash
 * changes. Every view paints a "Loading…" placeholder while it fetches, and a
 * fixed sleep spends part of each beat watching that placeholder — which is how
 * the first cut of this recording ended on one.
 */
async function beat(hash: string, hold: number, label: string): Promise<void> {
  process.stdout.write(`  ${label}\n`);
  await evaluate(`location.hash = ${JSON.stringify(hash)}`);

  for (let i = 0; i < 60; i += 1) {
    const result = (await evaluate(
      'document.querySelector("#view .empty")?.textContent ?? ""',
    )) as { result?: { value?: string } };
    if (!(result.result?.value ?? '').includes('Loading')) break;
    await sleep(100);
  }

  await sleep(hold);
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  // Rendered at 2x and streamed at 1x: the downscale is free supersampling, and
  // small type in a screen recording is the thing that reads worst.
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 800,
    deviceScaleFactor: 2,
    mobile: false,
  });

  await send('Page.navigate', { url: `${target}/#/` });
  await sleep(4000);

  process.stdout.write('\n  recording\n');
  await send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1180, maxHeight: 800 });

  await sleep(2600); // the headline cards
  await evaluate('window.scrollTo({ top: 620, behavior: "smooth" })');
  await sleep(2600); // open violations, with the confirmed ones on top

  await beat('#/violations', 2400, 'violations');
  await evaluate(`(() => {
    const s = document.querySelector('select');
    if (!s) return;
    s.value = 'peakNetEdge';
    s.dispatchEvent(new Event('change'));
  })()`);
  await sleep(2400);

  await beat('#/lifetimes', 3800, 'lifetime distribution');

  await beat(`#/families?family=${encodeURIComponent(PARTITION)}`, 4200, 'partition — sums past 1.00');
  await evaluate('window.scrollTo({ top: 240, behavior: "smooth" })');
  await sleep(2200);

  await beat(`#/families?family=${encodeURIComponent(LADDER)}`, 3800, 'ladder — priced above what it entails');
  await evaluate('window.scrollTo({ top: 300, behavior: "smooth" })');
  await sleep(3200); // the rungs that cross their own ceiling, and the broken-edge table

  await evaluate('window.scrollTo({ top: 0, behavior: "smooth" })');
  await beat('#/', 2600, 'back to status');

  await send('Page.stopScreencast');
  process.stdout.write(`\n  captured ${frames.length} frames\n`);

  if (frames.length < 2) throw new Error('no frames captured');

  // ---- assemble -------------------------------------------------------
  const base = frames[0]!.at;
  const lines: string[] = [];
  for (const [i, frame] of frames.entries()) {
    const next = frames[i + 1]?.at ?? frame.at + 1.2;
    // ffmpeg's concat demuxer wants a duration per entry; clamp so a stall
    // during capture cannot become a ten-second freeze in the output.
    const duration = Math.min(2.5, Math.max(0.04, next - frame.at));
    lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(3)}`);
    void base;
  }
  // The demuxer ignores the final duration unless the last file repeats.
  lines.push(`file '${frames.at(-1)!.file}'`);
  const listFile = join(frameDir, 'frames.txt');
  writeFileSync(listFile, lines.join('\n'));

  const mp4 = join(outDir, 'demo.mp4');
  const gif = join(outDir, 'demo.gif');
  const palette = join(frameDir, 'palette.png');

  ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-fps_mode', 'vfr', '-pix_fmt', 'yuv420p',
       '-c:v', 'libx264', '-crf', '24', '-movflags', '+faststart', mp4]);

  // Two passes: a palette built from the whole clip, then applied. One pass
  // with the default 216-colour web palette turns the dark theme to mud.
  const gifFilters = 'fps=10,scale=880:-1:flags=lanczos';
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-vf', `${gifFilters},palettegen=stats_mode=diff`, palette]);
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-i', palette, '-lavfi',
       `${gifFilters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`, gif]);

  process.stdout.write(`\n  ${gif}  ${sizeOf(gif)}\n  ${mp4}  ${sizeOf(mp4)}\n\n`);
} finally {
  ws.close();
  chrome.kill();
  rmSync(frameDir, { recursive: true, force: true });
}

process.exit(0);
