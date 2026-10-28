'use client';

/**
 * Small drawings of what each print setting means, for people who have not met the words before (EngCheck's form).
 * Line drawings in the text colour, the part that matters in the accent colour, a short label where a number helps.
 */

const ACCENT = '#3b82f6';
const PART = 'rgba(148, 163, 184, 0.35)';
const WARN = '#ef4444';

const Svg = ({ children, label }: { children: React.ReactNode; label: string }) => (
  <svg viewBox="0 0 120 80" width={150} height={100} role="img" aria-label={label} className="print-pic">
    {children}
  </svg>
);

/** A dimension line: the measured span with a tick across each end */
const Arrow = ({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) => {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const px = (-(y2 - y1) / len) * 3;
  const py = ((x2 - x1) / len) * 3;
  return (
    <g stroke={ACCENT} strokeWidth={1.5}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} />
      <line x1={x1 - px} y1={y1 - py} x2={x1 + px} y2={y1 + py} />
      <line x1={x2 - px} y1={y2 - py} x2={x2 + px} y2={y2 + py} />
    </g>
  );
};

/** A square plate with a round hole through it (the hole left empty, not painted over) */
const PlateWithHole = ({ x, y, size, cx, cy, r }: { x: number; y: number; size: number; cx: number; cy: number; r: number }) => (
  <path
    d={`M ${x} ${y} h ${size} v ${size} h ${-size} Z M ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} Z`}
    fill={PART}
    fillRule="evenodd"
    stroke="currentColor"
  />
);

const Text = ({ x, y, children, color = ACCENT }: { x: number; y: number; children: React.ReactNode; color?: string }) => (
  <text x={x} y={y} fontSize={10} fill={color} textAnchor="middle" fontFamily="sans-serif">
    {children}
  </text>
);

const PICTURES: Record<string, () => React.ReactElement> = {
  printer: () => (
    <Svg label="Máy in">
      <rect x={25} y={8} width={70} height={62} rx={4} fill="none" stroke="currentColor" strokeWidth={2} />
      <line x1={30} y1={22} x2={90} y2={22} stroke="currentColor" />
      <rect x={52} y={22} width={14} height={10} fill={ACCENT} />
      <polygon points="56,32 62,32 59,38" fill={ACCENT} />
      <rect x={40} y={56} width={40} height={4} fill="currentColor" />
      <rect x={50} y={46} width={20} height={10} fill={PART} stroke="currentColor" />
    </Svg>
  ),
  spool: () => (
    <Svg label="Cuộn nhựa">
      <circle cx={45} cy={40} r={28} fill="none" stroke="currentColor" strokeWidth={2} />
      <circle cx={45} cy={40} r={20} fill={ACCENT} opacity={0.5} />
      <circle cx={45} cy={40} r={7} fill="none" stroke="currentColor" strokeWidth={2} />
      <path d="M 65 30 Q 85 30 95 50 T 110 70" fill="none" stroke={ACCENT} strokeWidth={3} />
    </Svg>
  ),
  nozzle: () => (
    <Svg label="Cỡ đầu phun và bề rộng sợi nhựa">
      <polygon points="40,6 80,6 80,24 66,40 54,40 40,24" fill="none" stroke="currentColor" strokeWidth={2} />
      <rect x={54} y={40} width={12} height={6} fill={ACCENT} />
      <rect x={20} y={52} width={80} height={10} rx={5} fill={ACCENT} opacity={0.7} />
      <Arrow x1={54} y1={72} x2={66} y2={72} />
      <Text x={88} y={75}>0.4 mm</Text>
    </Svg>
  ),
  layers: () => (
    <Svg label="Chiều cao lớp">
      {[0, 1, 2, 3, 4].map((i) => (
        <rect key={i} x={20} y={60 - i * 11} width={60} height={9} rx={4} fill={i === 2 ? ACCENT : PART} stroke="currentColor" strokeWidth={0.8} />
      ))}
      <Arrow x1={92} y1={38} x2={92} y2={47} />
      <Text x={106} y={46}>0.2</Text>
    </Svg>
  ),
  walls: () => (
    <Svg label="Số lớp vỏ: nhìn từ trên xuống">
      <rect x={8} y={8} width={70} height={64} fill="none" stroke={ACCENT} strokeWidth={3} />
      <rect x={13} y={13} width={60} height={54} fill="none" stroke={ACCENT} strokeWidth={3} />
      <g stroke="currentColor" strokeWidth={0.8} opacity={0.6}>
        {[0, 1, 2, 3, 4].map((i) => (
          <line key={i} x1={20 + i * 12} y1={18} x2={20 + i * 12} y2={62} />
        ))}
      </g>
      <Text x={100} y={30}>2 vỏ</Text>
      <Text x={100} y={52} color="currentColor">bên</Text>
      <Text x={100} y={64} color="currentColor">trong</Text>
    </Svg>
  ),
  infill: () => (
    <Svg label="Độ đặc bên trong">
      {[
        { x: 6, step: 14, pct: '15 %' },
        { x: 62, step: 6, pct: '40 %' },
      ].map(({ x, step, pct }) => (
        <g key={pct}>
          <rect x={x} y={6} width={52} height={52} fill="none" stroke="currentColor" strokeWidth={2} />
          <g stroke={ACCENT} strokeWidth={1.2}>
            {Array.from({ length: Math.floor(48 / step) }, (_, i) => (
              <g key={i}>
                <line x1={x + 4 + i * step} y1={8} x2={x + 4 + i * step} y2={56} />
                <line x1={x + 2} y1={10 + i * step} x2={x + 50} y2={10 + i * step} />
              </g>
            ))}
          </g>
          <Text x={x + 26} y={72} color="currentColor">{pct}</Text>
        </g>
      ))}
    </Svg>
  ),
  overhang: () => (
    <Svg label="Phần nhô ra cần đỡ">
      <line x1={8} y1={72} x2={112} y2={72} stroke="currentColor" strokeWidth={2} />
      {/* A part leaning out: fine up to the limit, sagging past it */}
      <polygon points="20,72 44,72 64,30 40,30" fill={PART} stroke="currentColor" />
      <line x1={44} y1={72} x2={44} y2={24} stroke="currentColor" strokeDasharray="3 3" />
      <path d="M 44 50 A 22 22 0 0 1 54 52" fill="none" stroke={ACCENT} strokeWidth={1.5} />
      <Text x={56} y={44}>45°</Text>
      <polygon points="70,72 82,72 110,40 98,40" fill={PART} stroke={WARN} />
      <g stroke={WARN} strokeWidth={1} strokeDasharray="2 2">
        {[86, 94, 102].map((x) => (
          <line key={x} x1={x} y1={72} x2={x} y2={52 - (x - 86) * 0.9} />
        ))}
      </g>
      <Text x={96} y={20} color={WARN}>cần đỡ</Text>
    </Svg>
  ),
  hole: () => (
    <Svg label="Lỗ in ra nhỏ đi">
      <PlateWithHole x={14} y={8} size={64} cx={46} cy={40} r={19} />
      <circle cx={46} cy={40} r={19} fill="none" stroke={ACCENT} strokeWidth={2} />
      {/* As drawn, larger than it prints */}
      <circle cx={46} cy={40} r={24} fill="none" stroke="currentColor" strokeDasharray="4 3" />
      <Text x={100} y={30} color="currentColor">vẽ 10</Text>
      <Text x={100} y={48}>in 9.85</Text>
      <Text x={100} y={64} color={ACCENT}>→ 0.15</Text>
    </Svg>
  ),
  shaft: () => (
    <Svg label="Trục in ra to thêm">
      <circle cx={46} cy={40} r={26} fill={ACCENT} opacity={0.35} stroke={ACCENT} strokeWidth={2} />
      <circle cx={46} cy={40} r={22} fill="none" stroke="currentColor" strokeDasharray="4 3" />
      <Text x={100} y={30} color="currentColor">vẽ 10</Text>
      <Text x={100} y={48}>in 10.1</Text>
      <Text x={100} y={64} color={ACCENT}>→ 0.1</Text>
    </Svg>
  ),
  tolerance: () => (
    <Svg label="Sai lệch kích thước ngoài">
      <rect x={24} y={14} width={48} height={48} fill="none" stroke="currentColor" strokeDasharray="4 3" />
      <rect x={22} y={12} width={52} height={52} fill={PART} stroke={ACCENT} strokeWidth={2} />
      <Arrow x1={22} y1={72} x2={74} y2={72} />
      <Text x={98} y={34} color="currentColor">vẽ 20</Text>
      <Text x={98} y={50}>in 20.08</Text>
      <Text x={98} y={66} color={ACCENT}>→ ±0.08</Text>
    </Svg>
  ),
  clearance: () => (
    <Svg label="Khe hở giữa chốt và lỗ">
      <PlateWithHole x={10} y={8} size={64} cx={42} cy={40} r={22} />
      <circle cx={42} cy={40} r={17} fill={ACCENT} opacity={0.6} stroke={ACCENT} />
      {/* The gap on one side */}
      <line x1={59} y1={40} x2={64} y2={40} stroke={WARN} strokeWidth={2} />
      <Text x={98} y={30} color={WARN}>khe</Text>
      <Text x={98} y={42} color={WARN}>mỗi bên</Text>
      <Text x={98} y={58} color="currentColor">chốt</Text>
      <Text x={98} y={70} color="currentColor">xoay được</Text>
    </Svg>
  ),
};

export function PrintIllustration({ name }: { name?: string }) {
  const draw = name ? PICTURES[name] : undefined;
  return draw ? draw() : null;
}
