import { useMemo, useState } from 'react';
import type { SpanDto, TraceDto } from '@shared/types';
import { Badge, SourceBadge, StatusBadge } from '../ui/Badge';
import { fmtMs } from '../../lib/format';
import { JsonBlock, StackBlock } from '../observability/common';

interface Node { span: SpanDto; depth: number }

/** Flatten spans into depth-first order (parent before children, siblings by start time). Orphans become roots. */
export function buildSpanTree(spans: SpanDto[]): Node[] {
  const ids = new Set(spans.map(s => s.spanId));
  const children = new Map<string | null, SpanDto[]>();
  for (const s of spans) {
    const key = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : null;
    const list = children.get(key) ?? [];
    list.push(s);
    children.set(key, list);
  }
  for (const list of children.values()) list.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const out: Node[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const s of children.get(parent) ?? []) {
      if (seen.has(s.spanId)) continue; // guard against cycles
      seen.add(s.spanId);
      out.push({ span: s, depth });
      walk(s.spanId, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function SpanRow({ node, t0, total }: { node: Node; t0: number; total: number }) {
  const [open, setOpen] = useState(false);
  const { span, depth } = node;
  const failed = span.status === 'ERROR';
  const start = Date.parse(span.startedAt);
  const dur = span.durationMs ?? (span.endedAt ? Date.parse(span.endedAt) - start : 0);
  const left = Math.max(0, Math.min(100, ((start - t0) / total) * 100));
  const width = Math.max(0.6, Math.min(100 - left, (dur / total) * 100));
  return (
    <li data-testid={failed ? 'span-row-failed' : 'span-row'} data-span-id={span.spanId} data-depth={depth} data-status={span.status}
      className={`border-b border-slate-100 last:border-0 dark:border-slate-800 ${failed ? 'bg-red-50 dark:bg-red-950/30' : ''}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)}
        className="grid w-full grid-cols-[minmax(12rem,22rem)_minmax(10rem,1fr)] items-center gap-3 px-2 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50">
        <div className="min-w-0" style={{ paddingLeft: `${depth * 16}px` }}>
          <div className="flex flex-wrap items-center gap-1.5">
            {depth > 0 && <span aria-hidden="true" className="text-slate-500 dark:text-slate-400">&#x2514;</span>}
            <span className={`truncate text-sm font-medium ${failed ? 'text-red-800 dark:text-red-200' : ''}`} title={span.name}>{span.name}</span>
            <Badge>{span.kind}</Badge>
            <SourceBadge source={span.source} />
            {failed && <Badge tone="red">FAILED</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative h-4 flex-1 rounded bg-slate-100 dark:bg-slate-800" aria-hidden="true">
            <div data-testid="span-bar" className={`absolute inset-y-0 rounded ${failed ? 'bg-red-500' : span.source === 'SIMULATED' ? 'bg-amber-400' : 'bg-brand-500'}`} style={{ left: `${left}%`, width: `${width}%` }} />
          </div>
          <span className="w-16 shrink-0 text-right text-xs tabular-nums text-slate-600 dark:text-slate-300">{span.durationMs === null ? (span.status === 'RUNNING' ? 'running' : '-') : fmtMs(span.durationMs)}</span>
        </div>
      </button>
      {failed && span.errorMessage && <div className="px-3 pb-2 text-xs text-red-700 dark:text-red-300" style={{ paddingLeft: `${depth * 16 + 12}px` }}>{span.errorMessage}</div>}
      {open && (
        <div className="space-y-2 px-3 pb-3" data-testid="span-detail" style={{ paddingLeft: `${depth * 16 + 12}px` }}>
          <div className="flex flex-wrap items-center gap-2 text-xs"><StatusBadge status={span.status} /><span className="font-mono">{span.spanId}</span></div>
          <StackBlock stack={span.stack} />
          <JsonBlock data={span.attributes} label="Span attributes" />
        </div>
      )}
    </li>
  );
}

export default function SpanWaterfall({ trace, spans }: { trace: TraceDto; spans: SpanDto[] }) {
  const nodes = useMemo(() => buildSpanTree(spans), [spans]);
  const { t0, total } = useMemo(() => {
    const starts = spans.map(s => Date.parse(s.startedAt));
    const traceStart = Date.parse(trace.startedAt);
    const t0 = Math.min(traceStart, ...starts);
    const ends = spans.map(s => (s.endedAt ? Date.parse(s.endedAt) : Date.parse(s.startedAt) + (s.durationMs ?? 0)));
    const traceEnd = trace.endedAt ? Date.parse(trace.endedAt) : traceStart + (trace.durationMs ?? 0);
    const total = Math.max(1, trace.durationMs ?? 0, traceEnd - t0, ...ends.map(e => e - t0));
    return { t0, total };
  }, [spans, trace]);
  if (spans.length === 0) return <div className="p-6 text-center text-sm text-slate-600 dark:text-slate-400" data-testid="empty-state">This trace has no spans.</div>;
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[36rem]">
        <div className="mb-1 flex justify-between px-2 text-xs text-slate-600 dark:text-slate-400" aria-hidden="true">
          <span>Span</span><span>Waterfall (0 - {fmtMs(total)})</span>
        </div>
        <ul data-testid="span-tree" className="rounded-md border border-slate-200 dark:border-slate-800">
          {nodes.map(n => <SpanRow key={n.span.spanId} node={n} t0={t0} total={total} />)}
        </ul>
      </div>
    </div>
  );
}
