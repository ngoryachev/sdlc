import type { ReactNode } from 'react';

export const Chip = ({ s }: { s: string }) => <span className={`chip ${s}`}>{s}</span>;
export const Money = ({ v }: { v: number }) => <span className="mono">${(v ?? 0).toFixed(2)}</span>;
export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.floor(d)}s`; if (d < 3600) return `${Math.floor(d / 60)}m`; if (d < 86400) return `${Math.floor(d / 3600)}h`; return `${Math.floor(d / 86400)}d`;
}
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return <div className="tabs">{tabs.map((t) => <button key={t.id} className={t.id === value ? 'on' : ''} onClick={() => onChange(t.id)}>{t.label}</button>)}</div>;
}
export function ConfirmButton({ label, onClick, className = 'danger' }: { label: string; onClick: () => void; className?: string }) {
  return <ArmButton label={label} onClick={onClick} className={className} />;
}
import { useEffect, useState } from 'react';
function ArmButton({ label, onClick, className }: { label: string; onClick: () => void; className: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3000); return () => clearTimeout(t); }, [armed]);
  return <button className={`${className} ${armed ? 'confirm' : ''}`} onClick={() => { if (armed) { setArmed(false); onClick(); } else setArmed(true); }}>{armed ? `Confirm ${label}?` : label}</button>;
}
