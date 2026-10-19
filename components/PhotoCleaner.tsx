'use client';

import { useEffect, useMemo, useState } from 'react';
import Stage from './Stage';
import { EMOJIS, MAX_PHOTOS, MAX_SIDE, blobOf, cropCanvas, makeCanvas, readInfo, render, saveBlob, stamp, transform, verifyBlob } from '../lib/image';
import type { Box, Row, Strength, Style } from '../lib/image';
import { detectFaces } from '../lib/detect';
import { zip } from '../lib/zip';
import { loadModes, saveModes } from '../lib/modes';
import type { Mode } from '../lib/modes';

type Photo = {
  id: number;
  name: string;
  base: HTMLCanvasElement;
  rows: Row[];
  rot: number;
  fh: boolean;
  fv: boolean;
  crop: Box | null;
  style: Style; // 遮蓋設定每張照片各自獨立
  emoji: string;
  strength: Strength;
  boxes: Box[];
  checked: boolean; // 已在第 3 步偵測並顯示給使用者看過
  ver: number; // 調整過照片就加 1，讓過期的偵測結果被丟掉
};

const getWork = (p: Photo) => {
  const t = transform(p.base, p.rot, p.fh, p.fv);
  return p.crop ? cropCanvas(t, p.crop) : t;
};
let nextId = 1;

export default function PhotoCleaner() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [idx, setIdx] = useState(0);
  const [step, setStep] = useState(0);
  const [precise, setPrecise] = useState(true);
  const [erase, setErase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [warn, setWarn] = useState<number[] | null>(null);
  const [verified, setVerified] = useState<'wait' | 'ok' | 'fail'>('wait');
  const [modes, setModes] = useState<Mode[]>([]);
  const [modeName, setModeName] = useState('');

  useEffect(() => setModes(loadModes()), []);

  const p: Photo | undefined = photos[idx];
  const upd = (id: number, patch: Partial<Photo>) => setPhotos((ps) => ps.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  // 任何調整都會讓原本的遮蓋框失效
  const edit = (patch: Partial<Photo>) => p && upd(p.id, { crop: null, ...patch, boxes: [], checked: false, ver: p.ver + 1 });
  const flip = (h: boolean) => p && edit((h ? p.rot % 180 === 0 : p.rot % 180 !== 0) ? { fh: !p.fh } : { fv: !p.fv });

  const preview = useMemo(() => (p ? transform(p.base, p.rot, p.fh, p.fv) : null), [p?.base, p?.rot, p?.fh, p?.fv]); // eslint-disable-line react-hooks/exhaustive-deps
  const work = useMemo(() => (preview && p ? (p.crop ? cropCanvas(preview, p.crop) : preview) : null), [preview, p?.crop]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(() => (work && p ? render(work, p.boxes, p.style, p.emoji, p.strength) : null), [work, p?.boxes, p?.style, p?.emoji, p?.strength]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onFiles(list: FileList | null) {
    if (!list?.length) return;
    const out: Photo[] = [];
    let bad = 0;
    for (const f of Array.from(list).slice(0, MAX_PHOTOS)) {
      try {
        const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
        const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
        const c = makeCanvas(bmp.width * s, bmp.height * s);
        c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close();
        out.push({ id: nextId++, name: f.name.replace(/\.[^.]+$/, ''), base: c, rows: await readInfo(f), rot: 0, fh: false, fv: false, crop: null, style: 'mosaic', emoji: EMOJIS[0], strength: 'mid', boxes: [], checked: false, ver: 0 });
      } catch {
        bad++;
      }
    }
    if (!out.length) return setMsg('無法讀取這些圖片。請改用 JPEG、PNG 或 WebP（iPhone 的 HEIC 請先轉成 JPEG）。');
    setMsg([list.length > MAX_PHOTOS && `一次最多 ${MAX_PHOTOS} 張，已取前 ${MAX_PHOTOS} 張。`, bad && `有 ${bad} 張無法讀取（HEIC 請先轉成 JPEG）。`].filter(Boolean).join(' '));
    setPhotos(out);
    setIdx(0);
    setStep(1);
  }

  async function runDetect(q: Photo, w: HTMLCanvasElement) {
    setBusy(true);
    setMsg('正在偵測人臉…（第一次需要載入模型，精細模式會比較久）');
    try {
      const found = await detectFaces(w, precise);
      setPhotos((ps) => ps.map((x) => (x.id === q.id && x.ver === q.ver ? { ...x, boxes: found, checked: true } : x)));
      setMsg(found.length ? `偵測到 ${found.length} 張臉。請確認是否都已涵蓋，漏掉的可以拖曳框選。` : '沒有偵測到人臉，可以拖曳手動框選。');
    } catch {
      setMsg('人臉偵測載入失敗，仍可拖曳手動框選要遮蓋的區域。');
    }
    setBusy(false);
  }

  // 切到還沒檢查過的照片時自動偵測
  useEffect(() => {
    if (step === 2 && p && work && !p.checked) runDetect(p, work);
  }, [step, idx, work]); // eslint-disable-line react-hooks/exhaustive-deps

  // 對目前的輸出檔再讀一次，確認沒有位置與機型資訊
  useEffect(() => {
    if (step !== 2 || !result) return;
    setVerified('wait');
    let dead = false;
    const t = setTimeout(async () => {
      const b = await blobOf(result);
      const ok = b ? await verifyBlob(b) : false;
      if (!dead) setVerified(ok ? 'ok' : 'fail');
    }, 400);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [step, result]);

  async function downloadOne() {
    if (!result || !p) return;
    const b = await blobOf(result);
    if (!b || !(await verifyBlob(b))) return setMsg('輸出檔驗證未通過，已停止下載。');
    saveBlob(b, `cleaned-${stamp()}-${idx + 1}.jpg`);
  }

  async function exportAll() {
    setBusy(true);
    setMsg('正在處理所有照片…');
    try {
      const t = stamp();
      const files: { name: string; data: Uint8Array<ArrayBuffer> }[] = [];
      for (const [i, q] of photos.entries()) {
        const b = await blobOf(render(getWork(q), q.boxes, q.style, q.emoji, q.strength));
        if (!b || !(await verifyBlob(b))) throw new Error('verify');
        files.push({ name: `cleaned-${t}-${i + 1}.jpg`, data: new Uint8Array(await b.arrayBuffer()) });
      }
      saveBlob(zip(files), `cleaned-photos-${t}.zip`);
      setMsg(`已下載 ${files.length} 張照片的 ZIP。`);
    } catch {
      setMsg('有照片的輸出檔驗證未通過，已停止下載。');
    }
    setBusy(false);
  }

  function downloadAll() {
    const un = photos.flatMap((q, i) => (q.checked ? [] : [i + 1]));
    if (un.length) setWarn(un);
    else exportAll();
  }

  // 自訂模式只在「所有照片設定一致」時提供
  const key = (q: Photo) => (q.style === 'emoji' ? `e${q.emoji}` : `${q.style}${q.strength}`);
  const uniform = photos.length > 0 && photos.every((q) => key(q) === key(photos[0]));
  const setLook = (patch: Partial<Pick<Photo, 'style' | 'emoji' | 'strength'>>) => p && upd(p.id, patch);
  const applyAll = () => p && setPhotos((ps) => ps.map((q) => ({ ...q, style: p.style, emoji: p.emoji, strength: p.strength })));
  const apply = (m: Mode) => {
    setPhotos((ps) => ps.map((q) => ({ ...q, style: m.style, emoji: m.emoji, strength: m.strength })));
    setPrecise(m.precise);
  };
  const putModes = (next: Mode[]) => {
    setModes(next);
    saveModes(next);
  };

  const labels = ['選擇照片', '調整照片', '遮蓋並下載'];
  const has = (k: Row['key']) => !!p?.rows.some((r) => r.key === k);
  const otherCount = p ? p.rows.filter((r) => r.key !== 'gps').length : 0;

  const nav = photos.length > 1 && (
    <div className="bar">
      <button onClick={() => setIdx((idx + photos.length - 1) % photos.length)} aria-label="上一張">
        ◀
      </button>
      <span className="cnt">
        {idx + 1} / {photos.length}
      </span>
      <button onClick={() => setIdx((idx + 1) % photos.length)} aria-label="下一張">
        ▶
      </button>
    </div>
  );

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
      <div className="msg">{msg}</div>

      {step === 0 && (
        <div className="panel">
          <label className="drop">
            點這裡選擇照片（最多 {MAX_PHOTOS} 張），或把照片拖進來
            <input type="file" accept="image/*" multiple onChange={(e) => onFiles(e.target.files)} />
          </label>
          <p className="note">手機拍的照片常藏有拍攝地點、時間與機型。這個工具會顯示它們，並在輸出時全部清除。</p>
        </div>
      )}

      {step === 1 && p && preview && (
        <div className="panel">
          {nav}
          <strong>這張照片藏有的資訊</strong>
          {p.rows.length ? (
            <ul className="meta">
              {p.rows.map((r) => (
                <li key={r.key}>
                  <span className={r.risk ? 'risk' : ''}>{r.label}</span>
                  <span>{r.value}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">沒有讀到位置或機型資訊（有些平台已先清除過）。輸出時仍會重新產生乾淨的檔案。</p>
          )}
          <div className="bar">
            <button onClick={() => edit({ rot: (p.rot + 270) % 360 })}>向左轉 90°</button>
            <button onClick={() => edit({ rot: (p.rot + 90) % 360 })}>向右轉 90°</button>
            <button onClick={() => flip(true)}>水平翻轉</button>
            <button onClick={() => flip(false)}>垂直翻轉</button>
            <button onClick={() => edit({})} disabled={!p.crop}>
              取消擷取
            </button>
          </div>
          <p className="hint">想只保留一部分？在照片上拖曳框出要保留的範圍（沒框選就是整張）。</p>
          <Stage src={preview} boxes={p.crop ? [p.crop] : []} onRect={(b) => edit({ crop: b })} />
          <div className="bar">
            <button onClick={() => setStep(0)}>重新選擇照片</button>
            <button className="go" onClick={() => setStep(2)}>
              下一步：遮蓋人臉
            </button>
          </div>
        </div>
      )}

      {step === 2 && p && work && result && (
        <>
          <div className="panel">
            {nav}
            <div className="bar">
              {(['mosaic', 'blur', 'emoji'] as Style[]).map((s) => (
                <button key={s} className={p.style === s ? 'on' : ''} onClick={() => setLook({ style: s })}>
                  {s === 'mosaic' ? '馬賽克' : s === 'blur' ? '模糊' : '動物貼圖'}
                </button>
              ))}
              {p.style !== 'emoji' &&
                (['coarse', 'mid', 'fine'] as Strength[]).map((s) => (
                  <button key={s} className={p.strength === s ? 'on' : ''} onClick={() => setLook({ strength: s })}>
                    {s === 'coarse' ? '粗' : s === 'mid' ? '中' : '細'}
                  </button>
                ))}
            </div>
            {p.style === 'emoji' && (
              <div className="bar emojis">
                {EMOJIS.map((e) => (
                  <button key={e} className={p.emoji === e ? 'on' : ''} onClick={() => setLook({ emoji: e })} aria-label={`使用 ${e}`}>
                    {e}
                  </button>
                ))}
              </div>
            )}
            {photos.length > 1 && (
              <div className="bar">
                <button onClick={applyAll}>全部照片套用這個設定</button>
              </div>
            )}
            <div className="bar">
              <button className={!erase ? 'on' : ''} onClick={() => setErase(false)}>
                新增框（拖曳）
              </button>
              <button className={erase ? 'on' : ''} onClick={() => setErase(true)}>
                橡皮擦（點框刪除）
              </button>
              <button onClick={() => upd(p.id, { boxes: [] })}>清除所有框</button>
            </div>
            <Stage
              src={result}
              boxes={p.boxes}
              erase={erase}
              onRect={(b) => upd(p.id, { boxes: [...p.boxes, b] })}
              onTap={(x, y) => {
                const m = work.width / 80;
                const i = p.boxes.map((b) => x >= b.x - m && x <= b.x + b.w + m && y >= b.y - m && y <= b.y + b.h + m).lastIndexOf(true);
                if (i >= 0) upd(p.id, { boxes: p.boxes.filter((_, j) => j !== i) });
              }}
            />
            <div className="bar">
              <button onClick={() => setStep(1)}>上一步</button>
              <button onClick={() => runDetect(p, work)} disabled={busy}>
                重新偵測人臉
              </button>
              <button className={precise ? 'on' : ''} onClick={() => setPrecise(!precise)}>
                精細偵測（較慢，可抓小臉）
              </button>
            </div>
            <div className="bar">
              <button className="go" onClick={downloadOne} disabled={busy}>
                下載這張
              </button>
              {photos.length > 1 && (
                <button className="go" onClick={downloadAll} disabled={busy}>
                  下載全部（ZIP）
                </button>
              )}
            </div>
            {warn && (
              <div className="panel warn">
                <strong>第 {warn.join('、')} 張尚未檢查</strong>
                <p className="hint">這些照片還沒確認人臉遮蓋，直接下載的話臉不會被遮蓋（位置等檔案資訊仍會清除）。</p>
                <div className="bar">
                  <button
                    className="go"
                    onClick={() => {
                      setIdx(warn[0] - 1);
                      setWarn(null);
                    }}
                  >
                    先幫我檢查
                  </button>
                  <button
                    onClick={() => {
                      setWarn(null);
                      exportAll();
                    }}
                  >
                    仍要下載
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="panel">
            <strong>隱私保護清單（第 {idx + 1} 張）</strong>
            <ul className="meta">
              <li>
                <span>位置資訊（GPS）</span>
                <span>{has('gps') ? '原本有 → 已清除' : '原本沒有'}</span>
              </li>
              <li>
                <span>拍攝時間、機型、軟體</span>
                <span>{otherCount ? `原本有 ${otherCount} 項 → 已清除` : '原本沒有'}</span>
              </li>
              <li>
                <span>縮圖與其他內附資訊</span>
                <span>已清除（輸出為重新繪製的新檔）</span>
              </li>
              <li>
                <span>臉部與遮蓋區域</span>
                <span className={p.boxes.length ? '' : 'risk'}>{p.boxes.length ? `已遮蓋 ${p.boxes.length} 處` : '尚未遮蓋'}</span>
              </li>
              <li>
                <span>輸出檔驗證</span>
                <span className={verified === 'fail' ? 'risk' : ''}>
                  {verified === 'ok' ? '已驗證：不含位置與機型資訊' : verified === 'fail' ? '驗證未通過，已禁止下載' : '檢查中…'}
                </span>
              </li>
            </ul>
            <p className="note">
              未處理：畫面內本身可辨識的內容（招牌、車牌、門牌）。自動偵測可能漏掉側臉、小臉或戴口罩的人，下載前請自行檢查。
            </p>
          </div>

          {uniform ? (
          <div className="panel">
            <strong>自訂模式</strong>
            <div className="bar">
              {modes.length ? (
                modes.map((m) => (
                  <span key={m.name}>
                    <button onClick={() => apply(m)}>{m.name}</button>
                    <button onClick={() => putModes(modes.filter((x) => x.name !== m.name))} aria-label={`刪除模式 ${m.name}`}>
                      ×
                    </button>
                  </span>
                ))
              ) : (
                <span className="hint">還沒有儲存的模式</span>
              )}
            </div>
            <div className="bar">
              <input type="text" value={modeName} maxLength={12} placeholder="為目前設定命名" onChange={(e) => setModeName(e.target.value)} />
              <button
                onClick={() => {
                  const name = modeName.trim();
                  if (!name) return;
                  putModes([...modes.filter((m) => m.name !== name), { name, style: p.style, emoji: p.emoji, strength: p.strength, precise }].slice(-10));
                  setModeName('');
                }}
              >
                儲存目前設定
              </button>
            </div>
            <p className="note">模式包含遮蓋樣式、貼圖、粗細與偵測精細度，只存在這個瀏覽器裡，不會上傳。最多 10 個。</p>
          </div>
          ) : (
            <p className="note">各張照片的遮蓋設定不同，自訂模式已隱藏。按「全部照片套用這個設定」可恢復。</p>
          )}
        </>
      )}
    </main>
  );
}
