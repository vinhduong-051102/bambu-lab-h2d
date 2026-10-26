import { Tag } from 'antd';
import { STATUS_LABELS } from '../prints';

export interface Label {
  id: string;
  label: string;
}

export const labelOf = (list: Label[], id: string) => list.find((o) => o.id === id)?.label ?? id;

const STATUS_COLORS: Record<string, string> = { printing: 'processing', finished: 'purple', failed: 'red', unknown: 'default' };
const OUTCOME_COLORS: Record<string, string> = { success: 'green', usable: 'gold', failed: 'red' };

export function StatusTag({ status }: { status: string }) {
  return <Tag color={STATUS_COLORS[status] ?? 'default'}>{(STATUS_LABELS as Record<string, string>)[status] ?? status}</Tag>;
}

export function OutcomeTag({ outcome, outcomes, prefix = '' }: { outcome: string | null | undefined; outcomes: Label[]; prefix?: string }) {
  if (!outcome) return null;
  return (
    <Tag color={OUTCOME_COLORS[outcome] ?? 'default'}>
      {prefix}
      {labelOf(outcomes, outcome)}
    </Tag>
  );
}
