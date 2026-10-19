export type Box = { x: number; y: number; w: number; h: number };
export type Style = 'mosaic' | 'blur' | 'emoji';
export type Strength = 'coarse' | 'mid' | 'fine';
export type Row = { key: 'gps' | 'time' | 'device' | 'software'; label: string; value: string; risk: boolean };

export const EMOJIS = ['🐶', '🐱', '🐸', '🐵', '🐼', '🦊', '🐰', '🐻'];
export const MAX_PHOTOS = 5;
export const MAX_SIDE = 2000;
const CELLS: Record<Strength, [number, number]> = { coarse: [6, 3], mid: [10, 5], fine: [16, 8] };

export const makeCanvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};

export const clip = (b: Box, W: number, H: number): Box => {
  const x = Math.max(0, Math.round(b.x));
  const y = Math.max(0, Math.round(b.y));
  return { x, y, w: Math.min(W, Math.round(b.x + b.w)) - x, h: Math.min(H, Math.round(b.y + b.h)) - y };
};

export function transform(src: HTMLCanvasElement, rot: number, fh: boolean, fv: boolean) {
  const swap = rot % 180 !== 0;
  const c = makeCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const g = c.getContext('2d')!;
  g.translate(c.width / 2, c.height / 2);
  g.rotate((rot * Math.PI) / 180);
  g.scale(fh ? -1 : 1, fv ? -1 : 1);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

export function cropCanvas(src: HTMLCanvasElement, b: Box) {
  const c = makeCanvas(b.w, b.h);
  c.getContext('2d')!.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, c.width, c.height);
  return c;
}

function pixelate(g: CanvasRenderingContext2D, src: HTMLCanvasElement, b: Box, cells: number, smooth: boolean) {
  const k = Math.max(b.w, b.h) / cells;
  const tw = Math.max(1, Math.round(b.w / k));
  const th = Math.max(1, Math.round(b.h / k));
  const t = makeCanvas(tw, th);
  t.getContext('2d')!.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, tw, th);
  g.save();
  g.imageSmoothingEnabled = smooth;
  g.imageSmoothingQuality = 'high';
  g.drawImage(t, 0, 0, tw, th, b.x, b.y, b.w, b.h);
  g.restore();
}

// 重新畫出一張新圖：只寫入像素，不會帶原檔的任何 metadata
export function render(work: HTMLCanvasElement, boxes: Box[], style: Style, emoji: string, strength: Strength) {
  const out = makeCanvas(work.width, work.height);
  const g = out.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(work, 0, 0);
  for (const b of boxes) {
    pixelate(g, work, b, style === 'emoji' ? 8 : CELLS[strength][style === 'blur' ? 1 : 0], style === 'blur');
    if (style === 'emoji') {
      g.font = `${Math.max(b.w, b.h) * 1.05}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(emoji, b.x + b.w / 2, b.y + b.h / 2);
    }
  }
  return out;
}

export async function readInfo(file: File): Promise<Row[]> {
  const rows: Row[] = [];
  try {
    const exifr = (await import('exifr')).default;
    const gps = await exifr.gps(file);
    if (gps && typeof gps.latitude === 'number') {
      rows.push({ key: 'gps', label: '拍攝地點（GPS）', value: `${gps.latitude.toFixed(5)}, ${gps.longitude.toFixed(5)}`, risk: true });
    }
    const t = await exifr.parse(file, ['Make', 'Model', 'DateTimeOriginal', 'Software']);
    if (t?.DateTimeOriginal) rows.push({ key: 'time', label: '拍攝時間', value: new Date(t.DateTimeOriginal).toLocaleString('zh-TW'), risk: false });
    if (t?.Make || t?.Model) rows.push({ key: 'device', label: '手機／相機型號', value: `${t.Make ?? ''} ${t.Model ?? ''}`.trim(), risk: false });
    if (t?.Software) rows.push({ key: 'software', label: '軟體', value: String(t.Software), risk: false });
  } catch {
    /* 讀不到就視為沒有 */
  }
  return rows;
}

export const blobOf = (c: HTMLCanvasElement) => new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.95));

// 對輸出檔再讀一次：讀到位置或機型資訊就視為驗證失敗
export async function verifyBlob(b: Blob) {
  try {
    const exifr = (await import('exifr')).default;
    const gps = await exifr.gps(b);
    const t = await exifr.parse(b, ['Make', 'Model', 'DateTimeOriginal', 'Software']);
    return !gps && !t?.Make && !t?.Model && !t?.DateTimeOriginal && !t?.Software;
  } catch {
    return false;
  }
}

// 以本機日期時間命名，例如 20261019-153042
export function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function saveBlob(b: Blob, name: string) {
  const url = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
