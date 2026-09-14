import { useEffect, useState } from 'react';
import type { SdlcEvent } from '@sdlc/shared';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';

export function EventsPage() {
  const live = useStore((s) => s.rawEvents);
  const [hist, setHist] = useState<SdlcEvent[]>([]);
  const [filter, setFilter] = useState('');
  useEffect(() => { void api.events(0, 200).then((r) => setHist(r.events as SdlcEvent[])); }, []);
  const all = [...hist, ...live.filter((e) => !hist.some((h) => h.id === e.id))].sort((a, b) => b.id - a.id).filter((e) => !filter || e.type.includes(filter) || (e.taskId ?? '').includes(filter));
  return (
    <div className="card">
      <div className="row"><h3 className="grow" style={{ margin: 0 }}>Events</h3><input style={{ width: 240 }} placeholder="filter by type or task" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
      <table><tbody>{all.slice(0, 300).map((e) => (
        <tr key={e.id}><td className="mono small muted">{e.id}</td><td className="small muted">{e.ts.slice(11, 19)}</td><td className="mono small">{e.type}</td><td className="mono small muted">{e.taskId}</td><td><details><summary className="small">{summary(e)}</summary><pre className="small">{JSON.stringify(e.payload, null, 2)}</pre></details></td></tr>
      ))}</tbody></table>
    </div>
  );
}
function summary(e: SdlcEvent): string {
  const p = e.payload as Record<string, unknown>;
  if (e.type === 'task.status') return `${p.from} → ${p.to}`;
  if (e.type.startsWith('phase.')) { const pr = p.phaseRun as { phaseName?: string; status?: string } | undefined; return pr ? `${pr.phaseName} ${pr.status}` : String(p.summary ?? ''); }
  if (e.type.startsWith('hil.')) { const h = p.hil as { kind: string; summary: string }; return `${h.kind}: ${h.summary}`; }
  return String(p.message ?? p.url ?? p.sha ?? '');
}
