import { clip, makeCanvas } from './image';
import type { Box } from './image';

type Det = Box & { s: number };
const TILE_MIN_SCORE = 0.6; // 小區塊偵測的分數門檻，誤判太多就調高、漏抓太多就調低

let detectorP: Promise<import('@mediapipe/tasks-vision').FaceDetector> | null = null;
function getDetector() {
  if (!detectorP) {
    detectorP = (async () => {
      const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const fileset = await FilesetResolver.forVisionTasks('/mediapipe');
      return FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/models/blaze_face_short_range.tflite' },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.25,
      });
    })();
    detectorP.catch(() => {
      detectorP = null;
    });
  }
  return detectorP;
}

const area = (b: Box) => b.w * b.h;
const overlap = (a: Box, b: Box) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};
// 合併重複的框：分數高的優先，重疊太多的視為同一張臉
function nms(ds: Det[]) {
  const out: Det[] = [];
  for (const d of ds.sort((a, b) => b.s - a.s)) {
    const dup = out.some((o) => {
      const i = overlap(o, d);
      return i / (area(o) + area(d) - i) > 0.3 || i / Math.min(area(o), area(d)) > 0.6;
    });
    if (!dup) out.push(d);
  }
  return out;
}
const starts = (d: number, t: number) => {
  if (d <= t) return [0];
  const n = Math.ceil((d - t) / (t * 0.6)) + 1;
  return Array.from({ length: n }, (_, i) => Math.round((i * (d - t)) / (n - 1)));
};

// precise = true 時額外用兩種大小的小區塊逐塊偵測，用來找遠景的小臉
export async function detectFaces(c: HTMLCanvasElement, precise: boolean): Promise<Box[]> {
  const det = await getDetector();
  const all: Det[] = [];
  const run = (src: HTMLCanvasElement, ox: number, oy: number, tile: boolean) => {
    for (const d of det.detect(src).detections) {
      const b = d.boundingBox;
      const s = d.categories[0]?.score ?? 0;
      if (!b) continue;
      if (tile) {
        // 小區塊容易誤判：提高分數門檻，排除不像臉的長寬比與被區塊邊緣切到的框
        const r = b.width / b.height;
        const cut =
          (b.originX < 3 && ox > 0) ||
          (b.originY < 3 && oy > 0) ||
          (b.originX + b.width > src.width - 3 && ox + src.width < c.width) ||
          (b.originY + b.height > src.height - 3 && oy + src.height < c.height);
        if (s < TILE_MIN_SCORE || r < 0.6 || r > 1.6 || cut) continue;
      }
      all.push({ x: b.originX + ox, y: b.originY + oy, w: b.width, h: b.height, s });
    }
  };
  run(c, 0, 0, false);
  if (precise) {
    const L = Math.max(c.width, c.height);
    let n = 0;
    for (const f of [1 / 3, 1 / 6]) {
      const t = Math.round(L * f);
      for (const y of starts(c.height, t)) {
        for (const x of starts(c.width, t)) {
          const w = Math.min(t, c.width - x);
          const h = Math.min(t, c.height - y);
          const tile = makeCanvas(w, h);
          tile.getContext('2d')!.drawImage(c, x, y, w, h, 0, 0, w, h);
          run(tile, x, y, true);
          if (++n % 12 === 0) await new Promise((r) => setTimeout(r));
        }
      }
    }
  }
  return nms(all).flatMap((d) => {
    const b = clip({ x: d.x - d.w * 0.25, y: d.y - d.h * 0.3, w: d.w * 1.5, h: d.h * 1.5 }, c.width, c.height);
    return b.w > 4 && b.h > 4 ? [b] : [];
  });
}
