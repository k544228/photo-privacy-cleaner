'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type Box = { x: number; y: number; w: number; h: number };
type Style = 'mosaic' | 'blur' | 'emoji';
type Row = { label: string; value: string; risk: boolean };

const EMOJIS = ['🐶', '🐱', '🐸', '🐵', '🐼', '🦊', '🐰', '🐻'];
const MAX_SIDE = 3000;

const makeCanvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};

const clip = (b: Box, W: number, H: number): Box => {
  const x = Math.max(0, Math.round(b.x));
  const y = Math.max(0, Math.round(b.y));
  return { x, y, w: Math.min(W, Math.round(b.x + b.w)) - x, h: Math.min(H, Math.round(b.y + b.h)) - y };
};

function transform(src: HTMLCanvasElement, rot: number, fh: boolean, fv: boolean) {
  const swap = rot % 180 !== 0;
  const c = makeCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const g = c.getContext('2d')!;
  g.translate(c.width / 2, c.height / 2);
  g.rotate((rot * Math.PI) / 180);
  g.scale(fh ? -1 : 1, fv ? -1 : 1);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

function cropCanvas(src: HTMLCanvasElement, b: Box) {
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

// 重新畫出一張新圖：不會帶原檔的任何 metadata
function render(work: HTMLCanvasElement, boxes: Box[], style: Style, emoji: string) {
  const out = makeCanvas(work.width, work.height);
  const g = out.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(work, 0, 0);
  for (const b of boxes) {
    pixelate(g, work, b, style === 'blur' ? 5 : style === 'mosaic' ? 10 : 8, style === 'blur');
    if (style === 'emoji') {
      g.font = `${Math.max(b.w, b.h) * 1.05}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(emoji, b.x + b.w / 2, b.y + b.h / 2);
    }
  }
  return out;
}

async function readInfo(file: File): Promise<Row[]> {
  const rows: Row[] = [];
  try {
    const exifr = (await import('exifr')).default;
    const gps = await exifr.gps(file);
    if (gps && typeof gps.latitude === 'number') {
      rows.push({ label: '拍攝地點（GPS）', value: `${gps.latitude.toFixed(5)}, ${gps.longitude.toFixed(5)}`, risk: true });
    }
    const t = await exifr.parse(file, ['Make', 'Model', 'DateTimeOriginal', 'Software']);
    if (t?.DateTimeOriginal) rows.push({ label: '拍攝時間', value: new Date(t.DateTimeOriginal).toLocaleString('zh-TW'), risk: false });
    if (t?.Make || t?.Model) rows.push({ label: '手機／相機型號', value: `${t.Make ?? ''} ${t.Model ?? ''}`.trim(), risk: false });
    if (t?.Software) rows.push({ label: '軟體', value: String(t.Software), risk: false });
  } catch {
    /* 讀不到就視為沒有 */
  }
  return rows;
}

let detectorP: Promise<import('@mediapipe/tasks-vision').FaceDetector> | null = null;
function getDetector() {
  if (!detectorP) {
    detectorP = (async () => {
      const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const fileset = await FilesetResolver.forVisionTasks('/mediapipe');
      return FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/models/blaze_face_short_range.tflite' },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.4,
      });
    })();
    detectorP.catch(() => {
      detectorP = null;
    });
  }
  return detectorP;
}

function Stage(props: {
  src: HTMLCanvasElement;
  boxes: Box[];
  onRect: (b: Box) => void;
  onTap?: (x: number, y: number) => void;
}) {
  const { src, boxes, onRect, onTap } = props;
  const ref = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const pt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * src.width) / r.width, y: ((e.clientY - r.top) * src.height) / r.height };
  };

  useEffect(() => {
    const c = ref.current!;
    c.width = src.width;
    c.height = src.height;
    const g = c.getContext('2d')!;
    g.drawImage(src, 0, 0);
    const lw = Math.max(2, src.width / 300);
    g.lineWidth = lw;
    g.strokeStyle = '#e5365b';
    boxes.forEach((b) => g.strokeRect(b.x, b.y, b.w, b.h));
    if (drag) {
      g.strokeStyle = '#2447f5';
      g.setLineDash([lw * 3, lw * 3]);
      g.strokeRect(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    }
  }, [src, boxes, drag]);

  return (
    <canvas
      ref={ref}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = pt(e);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const p = pt(e);
        setDrag({ ...drag, x1: p.x, y1: p.y });
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        const p = pt(e);
        const moved = Math.hypot(p.x - drag.x0, p.y - drag.y0) > src.width / 60;
        if (moved) {
          const b = clip(
            { x: Math.min(drag.x0, p.x), y: Math.min(drag.y0, p.y), w: Math.abs(p.x - drag.x0), h: Math.abs(p.y - drag.y0) },
            src.width,
            src.height
          );
          if (b.w > 4 && b.h > 4) onRect(b);
        } else {
          onTap?.(p.x, p.y);
        }
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    />
  );
}

export default function PhotoCleaner() {
  const [step, setStep] = useState(0);
  const [base, setBase] = useState<HTMLCanvasElement | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [rot, setRot] = useState(0);
  const [fh, setFh] = useState(false);
  const [fv, setFv] = useState(false);
  const [crop, setCrop] = useState<Box | null>(null);
  const [work, setWork] = useState<HTMLCanvasElement | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [style, setStyle] = useState<Style>('mosaic');
  const [emoji, setEmoji] = useState(EMOJIS[0]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const preview = useMemo(() => (base ? transform(base, rot, fh, fv) : null), [base, rot, fh, fv]);
  const result = useMemo(() => (work ? render(work, boxes, style, emoji) : null), [work, boxes, style, emoji]);

  async function onFile(file?: File) {
    if (!file) return;
    setMsg('');
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      const c = makeCanvas(bmp.width * s, bmp.height * s);
      c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      setRows(await readInfo(file));
      setBase(c);
      setRot(0);
      setFh(false);
      setFv(false);
      setCrop(null);
      setStep(1);
    } catch {
      setMsg('無法讀取這張圖片。請改用 JPEG、PNG 或 WebP（iPhone 的 HEIC 請先轉成 JPEG）。');
    }
  }

  const change = (fn: () => void) => {
    fn();
    setCrop(null);
  };
  // 旋轉 90 度後，畫面上的「水平」對應原圖的另一軸，所以要換軸翻轉
  const flip = (horizontal: boolean) =>
    change(() => ((horizontal ? rot % 180 === 0 : rot % 180 !== 0) ? setFh(!fh) : setFv(!fv)));

  async function detect(w: HTMLCanvasElement) {
    setBusy(true);
    setMsg('正在偵測人臉…（第一次需要載入模型）');
    try {
      const d = await getDetector();
      const found = d.detect(w).detections.flatMap((det) => {
        const b = det.boundingBox;
        if (!b) return [];
        const box = clip(
          { x: b.originX - b.width * 0.25, y: b.originY - b.height * 0.3, w: b.width * 1.5, h: b.height * 1.5 },
          w.width,
          w.height
        );
        return box.w > 4 && box.h > 4 ? [box] : [];
      });
      setBoxes(found);
      setMsg(found.length ? `偵測到 ${found.length} 張臉。請確認是否都已涵蓋，漏掉的可以拖曳框選。` : '沒有偵測到人臉，可以拖曳手動框選。');
    } catch {
      setMsg('人臉偵測載入失敗，仍可拖曳手動框選要遮蓋的區域。');
    }
    setBusy(false);
  }

  function toCover() {
    if (!preview) return;
    const w = crop ? cropCanvas(preview, crop) : preview;
    setWork(w);
    setBoxes([]);
    setStep(2);
    detect(w);
  }

  function download() {
    result?.toBlob(
      (b) => {
        if (!b) return;
        const url = URL.createObjectURL(b);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'cleaned-photo.jpg';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      'image/jpeg',
      0.95
    );
  }

  const labels = ['選擇照片', '調整照片', '遮蓋並下載'];

  return (
    <main>
      <h1>
        照片<span>隱私</span>清除器
      </h1>
      <p className="sub">在你的裝置上處理，照片不會上傳到任何地方。</p>

      <div className="steps">
        {labels.map((t, i) => (
          <div key={t} className={i === step ? 'on' : ''}>
            {t}
          </div>
        ))}
      </div>

      {step === 0 && (
        <div className="panel">
          <label className="drop">
            點這裡選擇照片，或把照片拖進來
            <input type="file" accept="image/*" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <p className="note">手機拍的照片常藏有拍攝地點、時間與機型。這個工具會顯示它們，並在輸出時全部清除。</p>
          <div className="msg">{msg}</div>
        </div>
      )}

      {step === 1 && preview && (
        <div className="panel">
          <strong>這張照片藏有的資訊</strong>
          {rows.length ? (
            <ul className="meta">
              {rows.map((r) => (
                <li key={r.label}>
                  <span className={r.risk ? 'risk' : ''}>{r.label}</span>
                  <span>{r.value}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">沒有讀到位置或機型資訊（有些平台已先清除過）。輸出時仍會重新產生乾淨的檔案。</p>
          )}
          <div className="bar">
            <button onClick={() => change(() => setRot((rot + 270) % 360))}>向左轉 90°</button>
            <button onClick={() => change(() => setRot((rot + 90) % 360))}>向右轉 90°</button>
            <button onClick={() => flip(true)}>水平翻轉</button>
            <button onClick={() => flip(false)}>垂直翻轉</button>
            <button onClick={() => setCrop(null)} disabled={!crop}>
              取消擷取
            </button>
          </div>
          <p className="hint">想只保留一部分？在照片上拖曳框出要保留的範圍（沒框選就是整張）。</p>
          <Stage src={preview} boxes={crop ? [crop] : []} onRect={setCrop} />
          <div className="bar">
            <button onClick={() => setStep(0)}>換一張</button>
            <button className="go" onClick={toCover}>
              下一步：遮蓋人臉
            </button>
          </div>
        </div>
      )}

      {step === 2 && work && result && (
        <div className="panel">
          <div className="bar">
            {(['mosaic', 'blur', 'emoji'] as Style[]).map((s) => (
              <button key={s} className={style === s ? 'on' : ''} onClick={() => setStyle(s)}>
                {s === 'mosaic' ? '馬賽克' : s === 'blur' ? '模糊' : '動物貼圖'}
              </button>
            ))}
          </div>
          {style === 'emoji' && (
            <div className="bar emojis">
              {EMOJIS.map((e) => (
                <button key={e} className={emoji === e ? 'on' : ''} onClick={() => setEmoji(e)} aria-label={`使用 ${e}`}>
                  {e}
                </button>
              ))}
            </div>
          )}
          <p className="hint">拖曳可新增遮蓋範圍（車牌、門牌、招牌也可以）；點一下紅框可移除。</p>
          <div className="msg">{msg}</div>
          <Stage
            src={result}
            boxes={boxes}
            onRect={(b) => setBoxes([...boxes, b])}
            onTap={(x, y) => {
              const i = boxes.map((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h).lastIndexOf(true);
              if (i >= 0) setBoxes(boxes.filter((_, j) => j !== i));
            }}
          />
          <div className="bar">
            <button onClick={() => setStep(1)}>上一步</button>
            <button onClick={() => detect(work)} disabled={busy}>
              重新偵測人臉
            </button>
            <button onClick={() => setBoxes([])}>清除所有框</button>
            <button className="go" onClick={download} disabled={busy}>
              清除並下載
            </button>
          </div>
          <p className="note">
            自動偵測可能漏掉側臉、小臉或戴口罩的人，下載前請自行檢查。本工具只清除檔案資訊與你框選的區域，畫面中其他可辨識的內容不會處理。
          </p>
        </div>
      )}
    </main>
  );
}
