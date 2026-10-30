'use client';

import { Col, Flex, Row, Typography } from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CHART_INK as INK,
  dailyCost,
  FEATURE_COLORS,
  formatShare,
  formatTokens,
  formatUsd,
  niceScale,
  planTimeline,
  tokenParts,
  topTasks,
} from '../aiUsage';

/**
 * The AI usage statistics as charts (dataviz method: thin marks, one axis, recessive grid, a hover tooltip on every
 * mark, a legend for two series or more; the task table under them is the table view). Drawn in SVG at the width
 * the card gives them.
 */

type Tokens = { input: number; output: number; cache_read: number; cache_write: number; thinking: number };
type PlanUse = { from: number; to: number; used: number };
export type ChartTask = {
  id: string;
  feature: string;
  title: string;
  at: string;
  cost_usd: number | null;
  cost_share: number | null;
  total_tokens: number;
  duration_ms: number | null;
  plan: { five_hour?: PlanUse; seven_day?: PlanUse } | null;
};

const FONT = 11;
// Room above the plot for the top tick's label
const TOP = 8;

/** The width of the box it is in, following it */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** A chart's frame: its title, legend, the plot and a tooltip placed over the plot */
function Frame({ title, legend, children, tip }: { title: string; legend?: ReactNode; children: (width: number) => ReactNode; tip: Tip | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  return (
    <Flex vertical gap={6}>
      <Typography.Text strong>{title}</Typography.Text>
      {legend}
      <div ref={ref} style={{ position: 'relative', minHeight: 40 }}>
        {width > 0 && children(width)}
        {tip && (
          <div
            role="tooltip"
            style={{
              position: 'absolute',
              left: Math.min(Math.max(tip.x + 12, 0), Math.max(width - 220, 0)),
              top: Math.max(tip.y - 12, 0),
              width: 'max-content',
              maxWidth: 220,
              pointerEvents: 'none',
              background: '#182033',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 6,
              padding: '6px 8px',
              fontSize: 12,
              color: INK.primary,
              zIndex: 2,
            }}
          >
            {tip.content}
          </div>
        )}
      </div>
    </Flex>
  );
}

type Tip = { x: number; y: number; content: ReactNode };

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <Flex gap={12} wrap>
      {items.map((i) => (
        <Flex key={i.label} gap={6} align="center">
          <span style={{ width: 10, height: 10, borderRadius: 2, background: i.color, display: 'inline-block' }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {i.label}
          </Typography.Text>
        </Flex>
      ))}
    </Flex>
  );
}

/** A bar segment rounded 4px at its far end only (the end away from the baseline) */
function barPath(x: number, y: number, w: number, h: number, rounded: boolean) {
  const r = rounded ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

const Swatch = ({ color }: { color: string }) => (
  <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block', marginRight: 6 }} />
);

/** Cost per day, stacked by feature */
function DailyCost({ tasks, days, labels }: { tasks: ChartTask[]; days: number; labels: Record<string, string> }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const data = dailyCost(tasks, days);
  const scale = niceScale(Math.max(...data.days.map((d) => d.total), 0));
  const H = 180;
  const left = 44;
  const bottom = 20;
  return (
    <Frame
      title="Chi phí mỗi ngày (theo giá API)"
      tip={tip}
      legend={data.features.length > 1 ? <Legend items={data.features.map((f) => ({ label: labels[f] ?? f, color: FEATURE_COLORS[f as keyof typeof FEATURE_COLORS] }))} /> : null}
    >
      {(width) => {
        const plotW = width - left - 4;
        const band = plotW / Math.max(data.days.length, 1);
        const barW = Math.max(2, Math.min(28, band * 0.6));
        const y = (v: number) => TOP + (H - bottom - TOP) * (1 - v / scale.max);
        const every = Math.ceil(data.days.length / Math.max(1, Math.floor(plotW / 44)));
        return (
          <svg width={width} height={H} role="img" aria-label="Chi phí mỗi ngày" onMouseLeave={() => setTip(null)}>
            {scale.ticks.map((t) => (
              <g key={t}>
                <line x1={left} x2={width} y1={y(t)} y2={y(t)} stroke={t === 0 ? INK.baseline : INK.grid} strokeWidth={1} />
                <text x={left - 6} y={y(t) + 4} textAnchor="end" fontSize={FONT} fill={INK.muted} style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatUsd(t)}
                </text>
              </g>
            ))}
            {data.days.map((d, i) => {
              const x = left + i * band + (band - barW) / 2;
              let top = d.total;
              const order = data.features.filter((f) => d.parts[f]);
              return (
                <g key={d.day}>
                  {order.map((f, k) => {
                    const v = d.parts[f];
                    const y1 = y(top);
                    const h = Math.max(y(top - v) - y1, 1);
                    top -= v;
                    // 2px of surface between stacked segments
                    return (
                      <path
                        key={f}
                        d={barPath(x, y1, barW, h - (k === order.length - 1 ? 0 : 2), k === 0)}
                        fill={FEATURE_COLORS[f as keyof typeof FEATURE_COLORS]}
                      />
                    );
                  })}
                  {i % every === 0 && (
                    <text x={x + barW / 2} y={H - 5} textAnchor="middle" fontSize={FONT} fill={INK.muted}>
                      {d.label}
                    </text>
                  )}
                  {/* The hit target: the whole day's column */}
                  <rect
                    x={left + i * band}
                    y={TOP}
                    width={band}
                    height={H - bottom - TOP}
                    fill="transparent"
                    onMouseMove={() =>
                      setTip({
                        x: left + i * band + band / 2,
                        y: y(d.total),
                        content: (
                          <>
                            <b>{d.label}</b> · {formatUsd(d.total)}
                            {order.map((f) => (
                              <div key={f}>
                                <Swatch color={FEATURE_COLORS[f as keyof typeof FEATURE_COLORS]} />
                                {labels[f] ?? f}: {formatUsd(d.parts[f])}
                              </div>
                            ))}
                            {!order.length && <div>Không dùng AI</div>}
                          </>
                        ),
                      })
                    }
                  />
                </g>
              );
            })}
          </svg>
        );
      }}
    </Frame>
  );
}

/** The plan's 5-hour and 7-day use over time, as the tasks saw it */
function PlanOverTime({ tasks }: { tasks: ChartTask[] }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const points = planTimeline(tasks);
  const H = 180;
  const left = 40;
  const bottom = 20;
  const right = 64;
  const series = [
    { key: 'five' as const, label: 'Hạn mức 5 giờ', color: FEATURE_COLORS.cad },
    { key: 'seven' as const, label: 'Hạn mức 7 ngày', color: FEATURE_COLORS.figure },
  ];
  if (points.length < 2) {
    return (
      <Frame title="Hạn mức gói Claude đã dùng" tip={null}>
        {() => <Typography.Text type="secondary">Chưa có task nào báo hạn mức trong kỳ này.</Typography.Text>}
      </Frame>
    );
  }
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  return (
    <Frame title="Hạn mức gói Claude đã dùng (lúc các task chạy)" tip={tip} legend={<Legend items={series} />}>
      {(width) => {
        const plotW = width - left - right;
        const x = (t: number) => left + (t1 > t0 ? ((t - t0) / (t1 - t0)) * plotW : plotW / 2);
        const y = (v: number) => TOP + (H - bottom - TOP) * (1 - v);
        const fmt = (t: number) => new Date(t).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const nearest = (px: number) => points.reduce((best, p) => (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px) ? p : best), points[0]);
        const last = (key: 'five' | 'seven') => [...points].reverse().find((p) => p[key] !== null);
        return (
          <svg
            width={width}
            height={H}
            role="img"
            aria-label="Hạn mức gói Claude theo thời gian"
            onMouseMove={(e) => {
              const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              const p = nearest(e.clientX - box.left);
              setTip({
                x: x(p.t),
                y: y(Math.max(p.five ?? 0, p.seven ?? 0)),
                content: (
                  <>
                    <b>{fmt(p.t)}</b>
                    <div style={{ color: INK.secondary }}>{p.title}</div>
                    {series.map((s) => (
                      <div key={s.key}>
                        <Swatch color={s.color} />
                        {s.label}: {p[s.key] === null ? '—' : `${Math.round((p[s.key] as number) * 100)} %`}
                      </div>
                    ))}
                  </>
                ),
              });
            }}
            onMouseLeave={() => setTip(null)}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <g key={t}>
                <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} stroke={t === 0 ? INK.baseline : INK.grid} />
                <text x={left - 6} y={y(t) + 4} textAnchor="end" fontSize={FONT} fill={INK.muted}>
                  {t * 100} %
                </text>
              </g>
            ))}
            {[t0, t1].map((t, i) => (
              <text key={i} x={x(t)} y={H - 5} textAnchor={i ? 'end' : 'start'} fontSize={FONT} fill={INK.muted}>
                {fmt(t)}
              </text>
            ))}
            {tip && <line x1={tip.x} x2={tip.x} y1={TOP} y2={H - bottom} stroke={INK.muted} strokeDasharray="3 3" />}
            {series.map((s) => {
              const pts = points.filter((p) => p[s.key] !== null);
              const end = last(s.key);
              return (
                <g key={s.key}>
                  <path d={pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[s.key] as number).toFixed(1)}`).join('')} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
                  {end && (
                    <>
                      <circle cx={x(end.t)} cy={y(end[s.key] as number)} r={4} fill={s.color} stroke={INK.surface} strokeWidth={2} />
                      <text x={x(end.t) + 8} y={y(end[s.key] as number) + 4} fontSize={FONT} fill={INK.secondary}>
                        {s.key === 'five' ? '5 giờ' : '7 ngày'} {Math.round((end[s.key] as number) * 100)} %
                      </text>
                    </>
                  )}
                </g>
              );
            })}
          </svg>
        );
      }}
    </Frame>
  );
}

/** The tasks that cost most, as bars */
function TopTasks({ tasks, labels }: { tasks: ChartTask[]; labels: Record<string, string> }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const top = topTasks(tasks, 8);
  const row = 26;
  const H = top.length * row;
  const max = Math.max(...top.map((t) => t.cost_usd ?? 0), 0) || 1;
  if (!top.length) return null;
  return (
    <Frame title="Task tốn nhiều nhất" tip={tip}>
      {(width) => {
        const labelW = Math.min(220, width * 0.42);
        const valueW = 92;
        const plotW = Math.max(width - labelW - valueW, 20);
        return (
          <svg width={width} height={H} role="img" aria-label="Task tốn nhiều nhất" onMouseLeave={() => setTip(null)}>
            {top.map((t, i) => {
              const w = Math.max(((t.cost_usd ?? 0) / max) * plotW, 2);
              const y0 = i * row;
              const short = t.title.length > 34 ? `${t.title.slice(0, 33)}…` : t.title;
              return (
                <g
                  key={t.id}
                  onMouseMove={() =>
                    setTip({
                      x: labelW + w,
                      y: y0,
                      content: (
                        <>
                          <b>{t.title}</b>
                          <div>{labels[t.feature] ?? t.feature}</div>
                          <div>
                            {formatUsd(t.cost_usd)} · {formatShare(t.cost_share)} chi phí · {formatTokens(t.total_tokens)} token
                          </div>
                          {t.plan?.five_hour && <div>Hạn mức 5 giờ: +{Math.round(t.plan.five_hour.used * 100)} %</div>}
                        </>
                      ),
                    })
                  }
                >
                  <rect x={0} y={y0} width={width} height={row} fill="transparent" />
                  <text x={labelW - 8} y={y0 + row / 2 + 4} textAnchor="end" fontSize={FONT} fill={INK.secondary}>
                    {short}
                  </text>
                  <path d={`M${labelW},${y0 + 6}H${labelW + w - 4}Q${labelW + w},${y0 + 6} ${labelW + w},${y0 + 10}V${y0 + row - 10}Q${labelW + w},${y0 + row - 6} ${labelW + w - 4},${y0 + row - 6}H${labelW}Z`} fill={FEATURE_COLORS[t.feature as keyof typeof FEATURE_COLORS] ?? FEATURE_COLORS.cad} />
                  <text x={labelW + w + 6} y={y0 + row / 2 + 4} fontSize={FONT} fill={INK.primary} style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {formatUsd(t.cost_usd)} · {formatShare(t.cost_share, 0)}
                  </text>
                </g>
              );
            })}
            <line x1={labelW} x2={labelW} y1={0} y2={H} stroke={INK.baseline} />
          </svg>
        );
      }}
    </Frame>
  );
}

/** What the period's tokens are: one bar split by kind */
function TokenMix({ tokens }: { tokens: Tokens }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const parts = tokenParts(tokens).filter((p) => p.value > 0);
  if (!parts.length) return null;
  return (
    <Frame title="Token gồm những gì" tip={tip} legend={<Legend items={parts.map((p) => ({ label: `${p.label} ${formatShare(p.share)}`, color: p.color }))} />}>
      {(width) => {
        let x = 0;
        return (
          <svg width={width} height={28} role="img" aria-label="Thành phần token" onMouseLeave={() => setTip(null)}>
            {parts.map((p, i) => {
              const w = Math.max(p.share * width - (i < parts.length - 1 ? 2 : 0), 1);
              const x0 = x;
              x += p.share * width;
              return (
                <rect
                  key={p.key}
                  x={x0}
                  y={4}
                  width={w}
                  height={20}
                  rx={i === 0 || i === parts.length - 1 ? 4 : 0}
                  fill={p.color}
                  onMouseMove={() =>
                    setTip({
                      x: x0 + w / 2,
                      y: 24,
                      content: (
                        <>
                          <b>{p.label}</b>: {formatTokens(p.value)} ({formatShare(p.share)})
                          {p.key === 'output' && <div>trong đó suy nghĩ {formatTokens(tokens.thinking)}</div>}
                          {p.key === 'cache_read' && <div>Đọc lại ngữ cảnh đã lưu, rẻ hơn nhiều so với token vào thường</div>}
                        </>
                      ),
                    })
                  }
                />
              );
            })}
          </svg>
        );
      }}
    </Frame>
  );
}

export function AiUsageCharts({ tasks, tokens, days, labels }: { tasks: ChartTask[]; tokens: Tokens; days: number; labels: Record<string, string> }) {
  if (!tasks.length) return <Typography.Text type="secondary">Chưa có task AI nào trong kỳ này.</Typography.Text>;
  return (
    <Row gutter={[24, 20]}>
      <Col xs={24} xl={12}>
        <DailyCost tasks={tasks} days={days} labels={labels} />
      </Col>
      <Col xs={24} xl={12}>
        <PlanOverTime tasks={tasks} />
      </Col>
      <Col xs={24} xl={12}>
        <TopTasks tasks={tasks} labels={labels} />
      </Col>
      <Col xs={24} xl={12}>
        <TokenMix tokens={tokens} />
      </Col>
    </Row>
  );
}
