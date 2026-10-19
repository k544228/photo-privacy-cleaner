'use client';

import { useEffect, useRef, useState } from 'react';
import { clip } from '../lib/image';
import type { Box } from '../lib/image';

export default function Stage(props: {
  src: HTMLCanvasElement;
  boxes: Box[];
  onRect: (b: Box) => void;
  onTap?: (x: number, y: number) => void;
  erase?: boolean;
}) {
  const { src, boxes, onRect, onTap, erase } = props;
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
      style={{ cursor: erase ? 'pointer' : 'crosshair' }}
      onPointerDown={(e) => {
        if (erase) return;
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
        const p = pt(e);
        if (erase) return onTap?.(p.x, p.y);
        if (!drag) return;
        if (Math.hypot(p.x - drag.x0, p.y - drag.y0) > src.width / 60) {
          const b = clip(
            { x: Math.min(drag.x0, p.x), y: Math.min(drag.y0, p.y), w: Math.abs(p.x - drag.x0), h: Math.abs(p.y - drag.y0) },
            src.width,
            src.height
          );
          if (b.w > 4 && b.h > 4) onRect(b);
        }
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    />
  );
}
