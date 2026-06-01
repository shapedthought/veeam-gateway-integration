// Draggable + resizable dashboard widget grid.
import { useState, useEffect, useRef } from 'react';
import type { ReactNode, DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from './icons.tsx';

const DASH_KEY = 'vgw_dash_v1';
const DASH_COLS = 4;

export interface DashItem {
  id: string;
  defaultW: number;
  node: ReactNode;
}

interface Slot { id: string; w: number; h: number; }

function loadLayout(items: DashItem[]): Slot[] {
  let saved: Slot[] | null = null;
  try { saved = JSON.parse(localStorage.getItem(DASH_KEY) || 'null'); } catch { saved = null; }
  const defaults: Slot[] = items.map((i) => ({ id: i.id, w: i.defaultW || 1, h: 0 }));
  if (!Array.isArray(saved)) return defaults;
  const known = new Set(items.map((i) => i.id));
  const out: Slot[] = saved.filter((s) => known.has(s.id)).map((s) => ({ id: s.id, w: s.w || 1, h: s.h || 0 }));
  defaults.forEach((d) => { if (!out.some((o) => o.id === d.id)) out.push(d); });
  return out;
}

export function DashGrid({ items }: { items: DashItem[] }) {
  const [layout, setLayout] = useState<Slot[]>(() => loadLayout(items));
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const resizing = useRef<{ id: string; widgetEl: HTMLElement } | null>(null);

  useEffect(() => { localStorage.setItem(DASH_KEY, JSON.stringify(layout)); }, [layout]);

  const byId = (id: string) => items.find((i) => i.id === id);
  const setWH = (id: string, patch: Partial<Slot>) => setLayout((p) => p.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const onDragStart = (e: DragEvent, id: string) => {
    if ((e.target as HTMLElement).closest('input,select,textarea,button,a,.tbl-wrap,.resize-handle')) { e.preventDefault(); return; }
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', id); } catch { /* ignore */ }
  };
  const onDragOver = (e: DragEvent, id: string) => { e.preventDefault(); if (id !== overId) setOverId(id); };
  const onDrop = (e: DragEvent, targetId: string) => {
    e.preventDefault();
    if (!dragId || dragId === targetId) { setDragId(null); setOverId(null); return; }
    setLayout((p) => {
      const from = p.findIndex((l) => l.id === dragId);
      const to = p.findIndex((l) => l.id === targetId);
      if (from < 0 || to < 0) return p;
      const next = p.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setDragId(null); setOverId(null);
  };
  const onDragEnd = () => { setDragId(null); setOverId(null); };

  const startResize = (e: ReactPointerEvent, id: string) => {
    e.preventDefault(); e.stopPropagation();
    const widgetEl = (e.currentTarget as HTMLElement).closest('.widget') as HTMLElement | null;
    if (!widgetEl) return;
    resizing.current = { id, widgetEl };
    const move = (ev: PointerEvent) => {
      const r = resizing.current; if (!r || !gridRef.current) return;
      const gridRect = gridRef.current.getBoundingClientRect();
      const gap = 16;
      const colW = (gridRect.width - gap * (DASH_COLS - 1)) / DASH_COLS;
      const wRect = r.widgetEl.getBoundingClientRect();
      let span = Math.round((ev.clientX - wRect.left + gap) / (colW + gap));
      span = Math.max(1, Math.min(DASH_COLS, span));
      const h = Math.max(0, Math.round(ev.clientY - wRect.top));
      setWH(r.id, { w: span, h });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      resizing.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const reset = () => { localStorage.removeItem(DASH_KEY); setLayout(items.map((i) => ({ id: i.id, w: i.defaultW || 1, h: 0 }))); };

  return (
    <>
      <div className="dash-toolbar">
        <span className="dash-hint"><Icon name="panel" size={14} />Drag cards to rearrange · resize from the bottom-right corner</span>
        <button className="btn ghost xs" onClick={reset}><Icon name="refresh" size={13} />Reset layout</button>
      </div>
      <div className="dash-grid" ref={gridRef}>
        {layout.map((l) => {
          const it = byId(l.id);
          if (!it) return null;
          return (
            <div
              key={l.id}
              className={`widget${dragId === l.id ? ' dragging' : ''}${overId === l.id && dragId && dragId !== l.id ? ' dragover' : ''}`}
              style={{ gridColumn: `span ${l.w}`, minHeight: l.h ? l.h + 'px' : undefined }}
              draggable
              onDragStart={(e) => onDragStart(e, l.id)}
              onDragOver={(e) => onDragOver(e, l.id)}
              onDrop={(e) => onDrop(e, l.id)}
              onDragEnd={onDragEnd}
            >
              <span className="widget-grip" title="Drag to move"><Icon name="grip" size={15} /></span>
              {it.node}
              <span className="resize-handle" title="Resize" onPointerDown={(e) => startResize(e, l.id)}></span>
            </div>
          );
        })}
      </div>
    </>
  );
}
