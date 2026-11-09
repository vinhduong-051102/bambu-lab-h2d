'use client';

import { DownloadOutlined, FullscreenOutlined, UndoOutlined } from '@ant-design/icons';
import { Button, Flex, Modal, Typography, theme } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { fileUrl } from '../cad';
import type { Circuit } from './Circuit';
import type { CadJob } from './CadJob';

/**
 * The wiring diagram, drawn here rather than as graphviz's picture so it can be used: each module is a box with its
 * wired pins that can be dragged (where it was put is kept in this browser), hovering a module says what it does in
 * the circuit and what each pin is joined to, and hovering a wire picks out its whole net. It starts where graphviz
 * put each module (circuit.json `layout`), or in columns from the battery to the loads for jobs built before that.
 */

const WIDTH = 200;
const HEAD = 38;
const ROW = 20;
const PAD = 40;

/** What a module of each kind is for, when Claude didn't say (circuit `roles`) */
const ROLE: Record<string, string> = {
  battery: 'Nguồn điện chính của mạch.',
  charger: 'Sạc pin từ cổng USB và bảo vệ pin.',
  switch: 'Bật/tắt nguồn cho phần mạch phía sau.',
  converter: 'Đổi điện áp (hạ áp hoặc tăng áp) cho các tải phía sau.',
  mcu: 'Bộ điều khiển: chạy chương trình, đọc cảm biến và xuất tín hiệu điều khiển.',
  actuator: 'Cơ cấu chấp hành: biến điện thành chuyển động.',
  sensor: 'Cảm biến: đo và gửi tín hiệu về vi điều khiển.',
  display: 'Hiển thị thông tin.',
  led: 'Đèn báo hoặc chiếu sáng.',
};
/** The columns of the fallback layout, from the source of power to what it drives */
const ORDER: Record<string, number> = {
  battery: 0,
  charger: 0,
  switch: 1,
  converter: 2,
  mcu: 3,
};

type Point = { x: number; y: number };
type Hover = { kind: 'part'; part: string } | { kind: 'net'; net: string } | null;

const split = (ref: string) => {
  const dot = ref.indexOf('.');
  return [ref.slice(0, dot), ref.slice(dot + 1)] as const;
};
const volts = (v: number | undefined) => (v == null ? '' : `${v.toFixed(2)} V`);

function partPins(circuit: Circuit): Record<string, string[]> {
  const pins: Record<string, string[]> = {};
  for (const [part, p] of Object.entries(circuit.parts)) pins[part] = p.pins ? [...p.pins] : [];
  // Jobs built before circuit.json listed them: the pins in the order the nets name them
  for (const n of Object.values(circuit.nets))
    for (const ref of n.pins) {
      const [part, pin] = split(ref);
      if (pins[part] && !pins[part].includes(pin)) pins[part].push(pin);
    }
  return pins;
}

const height = (pins: string[]) => HEAD + ROW * Math.max(pins.length, 1) + 6;

/** Top-left corner of each box: graphviz's centres, or columns by kind */
function startLayout(circuit: Circuit, pins: Record<string, string[]>): Record<string, Point> {
  const parts = Object.keys(circuit.parts);
  const placed: Record<string, Point> = {};
  if (parts.every((p) => circuit.layout?.[p])) {
    // graphviz's boxes are smaller than these: spread its positions so ours don't overlap
    const xs = parts.map((p) => circuit.layout[p][0]);
    const minX = Math.min(...xs);
    for (const p of parts) {
      const [x, y] = circuit.layout[p];
      placed[p] = { x: (x - minX) * 1.25, y: y * 1.25 - height(pins[p]) / 2 };
    }
  } else {
    const columns: Record<number, string[]> = {};
    for (const p of parts) (columns[ORDER[circuit.parts[p].kind] ?? 4] ??= []).push(p);
    Object.keys(columns)
      .map(Number)
      .sort((a, b) => a - b)
      .forEach((column, i) => {
        let y = 0;
        for (const p of columns[column]) {
          placed[p] = { x: i * (WIDTH + 90), y };
          y += height(pins[p]) + 30;
        }
      });
  }
  const minY = Math.min(...parts.map((p) => placed[p].y));
  for (const p of parts) placed[p] = { x: placed[p].x + PAD, y: placed[p].y - minY + PAD };
  return placed;
}

const storageKey = (job: CadJob) => `circuit-layout:${job.id}`;

function savedLayout(job: CadJob, parts: string[]): Record<string, Point> | null {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(job)) ?? 'null') as Record<string, Point> | null;
    return saved && parts.every((p) => saved[p]) ? saved : null;
  } catch {
    return null;
  }
}

/** The diagram in the card, and full screen to work on a big circuit */
export function CircuitDiagram({ job, circuit }: { job: CadJob; circuit: Circuit }) {
  const [full, setFull] = useState(false);
  // Drawn again after full screen, with where the modules were moved there
  const [shown, setShown] = useState(0);
  return (
    <>
      <Diagram key={shown} job={job} circuit={circuit} onFull={() => setFull(true)} />
      <Modal
        open={full}
        onCancel={() => {
          setFull(false);
          setShown((n) => n + 1);
        }}
        footer={null}
        width="96vw"
        style={{ top: 16 }}
        title="Sơ đồ nối dây"
        destroyOnHidden
      >
        <Diagram job={job} circuit={circuit} />
      </Modal>
    </>
  );
}

function Diagram({ job, circuit, onFull }: { job: CadJob; circuit: Circuit; onFull?: () => void }) {
  const { token } = theme.useToken();
  const pins = useMemo(() => partPins(circuit), [circuit]);
  const start = useMemo(() => startLayout(circuit, pins), [circuit, pins]);
  const [pos, setPos] = useState(start);
  const [hover, setHover] = useState<Hover>(null);
  const [tip, setTip] = useState<(Point & { above: boolean }) | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{
    part: string;
    from: Point;
    at: Point;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    setPos(savedLayout(job, Object.keys(circuit.parts)) ?? start);
  }, [job, circuit, start]);

  const avg = circuit.simulation.cases?.avg;
  const netOf = useMemo(() => {
    const of: Record<string, string> = {};
    for (const [net, n] of Object.entries(circuit.nets)) for (const ref of n.pins) of[ref] = net;
    return of;
  }, [circuit]);
  const netVolts = (net: string) => {
    const n = circuit.nets[net];
    const pin = n.kind === 'gnd' ? undefined : n.pins.find((p) => avg?.pins[p] != null);
    return pin ? avg?.pins[pin] : undefined;
  };

  // The drawing's extent at the start, with room to drag a little past it
  const view = useMemo(() => {
    const parts = Object.keys(start);
    const right = Math.max(...parts.map((p) => start[p].x + WIDTH)) + PAD;
    const bottom = Math.max(...parts.map((p) => start[p].y + height(pins[p]))) + PAD;
    return { w: right, h: bottom };
  }, [start, pins]);

  const anchor = (ref: string, toward: number): Point & { dir: number } => {
    const [part, pin] = split(ref);
    const p = pos[part];
    const i = Math.max(pins[part]?.indexOf(pin) ?? 0, 0);
    const left = toward < p.x + WIDTH / 2;
    return {
      x: left ? p.x : p.x + WIDTH,
      y: p.y + HEAD + ROW * i + ROW / 2,
      dir: left ? -1 : 1,
    };
  };
  const centre = (part: string) => pos[part].x + WIDTH / 2;

  const toSvg = (e: { clientX: number; clientY: number }): Point => {
    const m = svg.current?.getScreenCTM();
    if (!m) return { x: e.clientX, y: e.clientY };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: pt.x, y: pt.y };
  };
  // On the page itself, by the pointer (the card's panel and the full-screen modal both clip what stands out of
  // them); above it near the bottom of the window, left of it near the right edge
  const showTip = (e: { clientX: number; clientY: number }) => setTip({ x: e.clientX, y: e.clientY, above: e.clientY > window.innerHeight - 240 });

  const onDown = (part: string) => (e: ReactPointerEvent) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { part, from: toSvg(e), at: pos[part], moved: false };
    setHover({ kind: 'part', part });
    showTip(e);
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const now = toSvg(e);
    const dx = now.x - d.from.x;
    const dy = now.y - d.from.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    const x = Math.min(Math.max(d.at.x + dx, 0), view.w - WIDTH);
    const y = Math.min(Math.max(d.at.y + dy, 0), view.h - height(pins[d.part]));
    setPos((p) => ({ ...p, [d.part]: { x, y } }));
    showTip(e);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved)
      setPos((p) => {
        try {
          localStorage.setItem(storageKey(job), JSON.stringify(p));
        } catch {
          // Kept for this page only
        }
        return p;
      });
  };
  const reset = () => {
    try {
      localStorage.removeItem(storageKey(job));
    } catch {
      // Nothing was kept
    }
    setPos(start);
  };

  // What the hover picks out: a net, or every net of a module
  const lit = new Set<string>();
  if (hover?.kind === 'net') lit.add(hover.net);
  if (hover?.kind === 'part') for (const pin of pins[hover.part]) if (netOf[`${hover.part}.${pin}`]) lit.add(netOf[`${hover.part}.${pin}`]);
  const dim = hover !== null;

  const wires = Object.entries(circuit.edges ?? {}).flatMap(([net, pairs]) =>
    pairs
      .filter(([a, b]) => pos[split(a)[0]] && pos[split(b)[0]])
      .map(([a, b], k) => {
        const pa = anchor(a, centre(split(b)[0]));
        const pb = anchor(b, centre(split(a)[0]));
        const bend = Math.max(40, Math.abs(pb.x - pa.x) / 2);
        const d = `M${pa.x},${pa.y} C${pa.x + pa.dir * bend},${pa.y} ${pb.x + pb.dir * bend},${pb.y} ${pb.x},${pb.y}`;
        return {
          key: `${net}-${k}`,
          net,
          d,
          mid: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 },
        };
      }),
  );
  const colour = (net: string) => (circuit.nets[net].kind === 'gnd' ? token.colorText : circuit.nets[net].colour);

  const part = hover?.kind === 'part' ? hover.part : null;
  const net = hover?.kind === 'net' ? hover.net : null;
  const regulator = part ? avg?.regulators[part] : undefined;

  return (
    <Flex vertical gap={6}>
      <Flex justify="space-between" align="center" wrap gap={6}>
        <Typography.Text type="secondary">
          Kéo các module để sắp xếp lại · rê chuột vào module để xem công dụng · rê vào dây để thấy đường đi của nó
        </Typography.Text>
        <Flex gap={6}>
          {onFull && (
            <Button size="small" icon={<FullscreenOutlined />} onClick={onFull}>
              Phóng to
            </Button>
          )}
          <Button size="small" icon={<UndoOutlined />} onClick={reset}>
            Xếp lại
          </Button>
          {job.files?.schematic && (
            <Button size="small" icon={<DownloadOutlined />} href={fileUrl(job, 'schematic.svg', true)}>
              SVG
            </Button>
          )}
        </Flex>
      </Flex>
      <div
        style={{
          position: 'relative',
          overflowX: 'auto',
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 8,
          background: token.colorBgContainer,
        }}
      >
        <svg
          ref={svg}
          viewBox={`0 0 ${view.w} ${view.h}`}
          style={{
            display: 'block',
            width: '100%',
            minWidth: 560,
            height: 'auto',
            maxHeight: onFull ? undefined : 'calc(100vh - 160px)',
            userSelect: 'none',
          }}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={() => {
            if (!drag.current) {
              setHover(null);
              setTip(null);
            }
          }}
          role="img"
          aria-label="Sơ đồ nối dây"
        >
          {wires.map((w) => (
            <g
              key={w.key}
              style={{ cursor: 'pointer' }}
              onPointerEnter={(e) => {
                if (drag.current) return;
                setHover({ kind: 'net', net: w.net });
                showTip(e);
              }}
              onPointerMove={(e) => !drag.current && showTip(e)}
              onPointerLeave={() => !drag.current && setHover(null)}
            >
              <path
                d={w.d}
                fill="none"
                stroke={colour(w.net)}
                strokeWidth={lit.has(w.net) ? 4.5 : 2}
                strokeOpacity={dim && !lit.has(w.net) ? 0.12 : 1}
                strokeLinecap="round"
              />
              {/* A wider invisible line so a thin wire is easy to hover */}
              <path d={w.d} fill="none" stroke="transparent" strokeWidth={14} />
            </g>
          ))}
          {Object.entries(circuit.parts).map(([name, p]) => {
            const at = pos[name];
            if (!at) return null;
            const faded = dim && part !== name && !pins[name].some((pin) => lit.has(netOf[`${name}.${pin}`]));
            return (
              <g
                key={name}
                transform={`translate(${at.x},${at.y})`}
                style={{
                  cursor: drag.current?.part === name ? 'grabbing' : 'grab',
                  touchAction: 'none',
                  opacity: faded ? 0.35 : 1,
                }}
                onPointerDown={onDown(name)}
                onPointerEnter={(e) => {
                  if (drag.current) return;
                  setHover({ kind: 'part', part: name });
                  showTip(e);
                }}
                onPointerMove={(e) => !drag.current && showTip(e)}
                onPointerLeave={() => !drag.current && setHover(null)}
              >
                <rect
                  width={WIDTH}
                  height={height(pins[name])}
                  rx={6}
                  fill={token.colorFillQuaternary}
                  stroke={part === name ? token.colorPrimary : token.colorBorder}
                  strokeWidth={part === name ? 2 : 1}
                />
                <rect width={WIDTH} height={HEAD} rx={6} fill={token.colorFillSecondary} />
                <text x={10} y={16} fontSize={12} fontWeight={600} fill={token.colorText}>
                  {name}
                </text>
                <text x={10} y={30} fontSize={10} fill={token.colorTextSecondary}>
                  {p.name.length > 34 ? `${p.name.slice(0, 33)}…` : p.name}
                </text>
                {pins[name].map((pin, i) => {
                  const pinNet = netOf[`${name}.${pin}`];
                  const y = HEAD + ROW * i + ROW / 2;
                  const on = pinNet && lit.has(pinNet);
                  return (
                    <g key={pin}>
                      <circle cx={0} cy={y} r={3} fill={pinNet ? colour(pinNet) : token.colorTextQuaternary} />
                      <circle cx={WIDTH} cy={y} r={3} fill={pinNet ? colour(pinNet) : token.colorTextQuaternary} />
                      <text x={10} y={y + 4} fontSize={11} fontWeight={on ? 600 : 400} fill={token.colorText}>
                        {pin}
                      </text>
                      <text x={WIDTH - 10} y={y + 4} fontSize={10} textAnchor="end" fill={on ? colour(pinNet) : token.colorTextSecondary}>
                        {pinNet ?? ''}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      {tip &&
        (part || net) &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              left: Math.max(Math.min(tip.x + 14, window.innerWidth - 296), 8),
              top: tip.above ? undefined : tip.y + 14,
              bottom: tip.above ? window.innerHeight - tip.y + 14 : undefined,
              width: 280,
              maxWidth: 'calc(100vw - 16px)',
              pointerEvents: 'none',
              background: token.colorBgElevated,
              boxShadow: token.boxShadowSecondary,
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: 12,
              // Over the full-screen modal
              zIndex: 2000,
            }}
          >
            {part && (
              <>
                <div style={{ fontWeight: 600 }}>
                  {part} · {circuit.parts[part].name}
                </div>
                <div style={{ margin: '4px 0' }}>{circuit.parts[part].role ?? ROLE[circuit.parts[part].kind] ?? ''}</div>
                {pins[part].map((pin) => {
                  const pinNet = netOf[`${part}.${pin}`];
                  return (
                    <div key={pin} style={{ color: token.colorTextSecondary }}>
                      {pin} → {pinNet ?? '—'} {pinNet && avg?.pins[`${part}.${pin}`] != null ? `(${volts(avg.pins[`${part}.${pin}`])})` : ''}
                    </div>
                  );
                })}
                {regulator && (
                  <div style={{ marginTop: 4 }}>
                    {volts(regulator.vin)} → {volts(regulator.vout)}, {Math.round(regulator.iout * 1000)} mA, tỏa {regulator.loss_w} W
                  </div>
                )}
                {circuit.parts[part].notes && <div style={{ marginTop: 4, color: token.colorTextSecondary }}>{circuit.parts[part].notes}</div>}
              </>
            )}
            {net && (
              <>
                <div style={{ fontWeight: 600, color: colour(net) }}>
                  {net} {netVolts(net) != null ? `· ${volts(netVolts(net))}` : circuit.nets[net].kind === 'gnd' ? '· 0 V' : ''}
                </div>
                <div style={{ color: token.colorTextSecondary }}>{circuit.nets[net].pins.join(' → ')}</div>
                {circuit.nets[net].length_mm != null && <div>Dây dài {Math.round(circuit.nets[net].length_mm!)} mm trong mô hình</div>}
              </>
            )}
          </div>,
          document.body,
        )}
    </Flex>
  );
}
