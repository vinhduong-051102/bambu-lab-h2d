'use client';

import { Flex, Tag, Typography } from 'antd';
import { useState } from 'react';

/**
 * The plate seen from above, as Studio shows it: the bed with its grid and each object's outline, to point at
 * the object a defect is on. The outlines are the footprints Studio sends with the print (mm from the plate's
 * corner, y towards the back). Prints sent before Studio sent them only have each object's size: those are laid
 * out in rows instead, and the map says the places are not the real ones.
 */

export interface PlateObject {
  name: string;
  size_mm?: number[];
  plate?: number;
  footprint?: [number, number][];
  /** Its true outline from above: outer contours and holes (drawn even-odd), from Studio since the outline patch */
  outline?: [number, number][][];
}

/** The H2D's plate, when Studio did not say */
const DEFAULT_BED: [number, number] = [350, 320];
const GAP = 8;

const SEVERITY_FILL: Record<string, string> = { minor: '#d4b106', major: '#fa8c16', critical: '#f5222d' };
const WORST = ['minor', 'major', 'critical'];

interface Shape {
  name: string;
  /** Number shown on it, 1-based in the plate's order */
  n: number;
  points: [number, number][];
  /** The true outline, when Studio sent it: drawn instead of `points` */
  rings?: [number, number][][];
  centre: [number, number];
}

const rect = (x: number, y: number, w: number, d: number): [number, number][] => [
  [x, y],
  [x + w, y],
  [x + w, y + d],
  [x, y + d],
];

function centreOf(points: [number, number][]): [number, number] {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

/** The objects' shapes on the bed, and whether they are where they really were */
export function layoutPlate(objects: PlateObject[], bed: [number, number] = DEFAULT_BED): { shapes: Shape[]; bed: [number, number]; real: boolean } {
  const outlineOf = (o: PlateObject) => o.outline?.filter((r) => r.length >= 3) ?? [];
  const real = objects.length > 0 && objects.every((o) => (o.footprint?.length ?? 0) >= 3 || outlineOf(o).length > 0);
  if (real) {
    return {
      bed,
      real,
      shapes: objects.map((o, i) => {
        const rings = outlineOf(o);
        const points = (o.footprint?.length ?? 0) >= 3 ? o.footprint! : rings.flat();
        return { name: o.name, n: i + 1, points, ...(rings.length ? { rings } : {}), centre: centreOf(points) };
      }),
    };
  }
  // Rows from the back left corner, the biggest first, as wide as the bed
  const order = objects.map((o, i) => ({ o, i })).sort((a, b) => (b.o.size_mm?.[1] ?? 20) - (a.o.size_mm?.[1] ?? 20));
  const shapes: Shape[] = [];
  let x = GAP;
  let top = bed[1] - GAP;
  let row = 0;
  for (const { o, i } of order) {
    const w = Math.max(o.size_mm?.[0] ?? 20, 4);
    const d = Math.max(o.size_mm?.[1] ?? 20, 4);
    if (x > GAP && x + w > bed[0] - GAP) {
      x = GAP;
      top -= row + GAP;
      row = 0;
    }
    const points = rect(x, top - d, w, d);
    shapes.push({ name: o.name, n: i + 1, points, centre: centreOf(points) });
    x += w + GAP;
    row = Math.max(row, d);
  }
  shapes.sort((a, b) => a.n - b.n);
  // Too many to fit: the bed grows downwards so every object shows
  const lowest = Math.min(GAP, ...shapes.flatMap((s) => s.points.map((p) => p[1])));
  const shift = GAP - lowest;
  if (shift > 0) for (const s of shapes) (s.points = s.points.map(([px, py]) => [px, py + shift])), (s.centre = [s.centre[0], s.centre[1] + shift]);
  return { bed: [bed[0], bed[1] + shift], real, shapes };
}

/** The objects on the plate that printed: Studio lists the whole project, every plate */
export function printedObjects(objects: PlateObject[], plate: number | undefined): PlateObject[] {
  if (!plate || !objects.some((o) => o.plate)) return objects;
  return objects.filter((o) => o.plate === plate);
}

export function PlateMap({
  objects,
  bed,
  marks = {},
  selected,
  onPick,
}: {
  objects: PlateObject[];
  bed?: [number, number];
  /** The worst severity reported on each object, by name */
  marks?: Record<string, string>;
  selected?: string | null;
  onPick?: (name: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  if (objects.length === 0) return null;
  const plate = layoutPlate(objects, bed);
  const [w, d] = plate.bed;
  // y up on the plate, down in the SVG
  const at = ([x, y]: [number, number]) => `${x.toFixed(1)},${(d - y).toFixed(1)}`;
  const grid: number[] = [];
  for (let g = 10; g < Math.max(w, d); g += 10) grid.push(g);
  const label = Math.max(6, Math.min(w, d) / 28);

  return (
    <Flex vertical gap={6} className="plate-map">
      <div style={{ position: 'relative', maxWidth: 520 }}>
        <svg viewBox={`-6 -6 ${w + 12} ${d + 12}`} style={{ width: '100%', display: 'block', background: '#2b2b2b', borderRadius: 6 }} role="img" aria-label="Plate nhìn từ trên xuống">
          <rect x={0} y={0} width={w} height={d} fill="#3d3d3d" stroke="#888" strokeWidth={1} rx={3} />
          {grid.map((g) => (
            <g key={g} stroke={g % 50 === 0 ? '#6a6a6a' : '#4f4f4f'} strokeWidth={g % 50 === 0 ? 0.6 : 0.35}>
              {g < w && <line x1={g} y1={0} x2={g} y2={d} />}
              {g < d && <line x1={0} y1={g} x2={w} y2={g} />}
            </g>
          ))}
          {plate.shapes.map((s) => {
            const mark = marks[s.name];
            const isSelected = selected === s.name;
            const isHover = hover === s.name;
            const fill = isSelected ? '#1677ff' : mark ? SEVERITY_FILL[mark] ?? '#fa8c16' : isHover ? '#5b7fb0' : '#1f1f1f';
            return (
              <g
                key={s.n}
                data-object={s.name}
                style={{ cursor: onPick ? 'pointer' : 'default' }}
                onMouseEnter={() => setHover(s.name)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onPick?.(s.name)}
              >
                <title>{`#${s.n} ${s.name}`}</title>
                {s.rings ? (
                  <path
                    d={s.rings.map((ring) => `M${ring.map(at).join('L')}Z`).join('')}
                    fillRule="evenodd"
                    fill={fill}
                    fillOpacity={isSelected || isHover ? 0.95 : 0.85}
                    stroke={isSelected || isHover ? '#ffffff' : '#0f0f0f'}
                    strokeWidth={isSelected || isHover ? 0.8 : 0.4}
                  />
                ) : (
                  <polygon
                    points={s.points.map(at).join(' ')}
                    fill={fill}
                    fillOpacity={isSelected || isHover ? 0.95 : 0.85}
                    stroke={isSelected || isHover ? '#ffffff' : '#0f0f0f'}
                    strokeWidth={isSelected || isHover ? 1.2 : 0.6}
                  />
                )}
                <text x={s.centre[0]} y={d - s.centre[1]} fill="#fff" fontSize={label} textAnchor="middle" dominantBaseline="central" pointerEvents="none" fontWeight={600}>
                  {s.n}
                </text>
              </g>
            );
          })}
        </svg>
        {hover && (
          <div className="plate-map-hover" style={{ position: 'absolute', left: 8, top: 8, pointerEvents: 'none' }}>
            <Tag color="blue">{hover}</Tag>
          </div>
        )}
      </div>
      {!plate.real && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Vị trí minh hoạ theo kích thước: bản in này được gửi khi Studio chưa gửi vị trí thật của vật thể.
        </Typography.Text>
      )}
      <Flex wrap gap={4}>
        {plate.shapes.map((s) => (
          <Tag
            key={s.n}
            color={selected === s.name ? 'blue' : marks[s.name] ? { minor: 'gold', major: 'orange', critical: 'red' }[marks[s.name]] : undefined}
            style={{ cursor: onPick ? 'pointer' : 'default', marginInlineEnd: 0 }}
            onClick={() => onPick?.(s.name)}
            onMouseEnter={() => setHover(s.name)}
            onMouseLeave={() => setHover(null)}
          >
            #{s.n} {s.name}
          </Tag>
        ))}
      </Flex>
    </Flex>
  );
}

/** The worst severity of the defects on each object */
export function worstByObject(defects: { object?: string; severity?: string }[]): Record<string, string> {
  const marks: Record<string, string> = {};
  for (const d of defects) {
    if (!d.object) continue;
    const severity = d.severity ?? 'major';
    if (WORST.indexOf(severity) > WORST.indexOf(marks[d.object] ?? '')) marks[d.object] = severity;
  }
  return marks;
}
