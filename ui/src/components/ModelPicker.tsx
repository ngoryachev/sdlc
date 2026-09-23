import type { EffortLevel, ModelOverrides } from '@sdlc/shared';

export interface ModelChoice { value: string; displayName: string; description?: string }
export const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** One row per phase: model + effort selects; an empty select means "inherit". */
export function ModelPicker({ phases, models, value, onChange, inheritLabel = 'inherit' }: {
  phases: string[]; models: ModelChoice[]; value: ModelOverrides; onChange: (v: ModelOverrides) => void; inheritLabel?: string;
}) {
  const set = (phase: string, key: 'model' | 'effort', v: string) => {
    const next: ModelOverrides = { ...value, [phase]: { ...(value[phase] ?? {}) } };
    if (v) (next[phase] as Record<string, string>)[key] = v; else delete (next[phase] as Record<string, string>)[key];
    if (!Object.keys(next[phase]!).length) delete next[phase];
    onChange(next);
  };
  const known = new Set(models.map((m) => m.value));
  return (
    <table className="small"><thead><tr><th>phase</th><th>model</th><th>effort</th></tr></thead><tbody>
      {phases.map((p) => { const cur = value[p] ?? {}; return (
        <tr key={p}><td className="mono">{p}</td>
          <td><select value={cur.model ?? ''} onChange={(e) => set(p, 'model', e.target.value)}>
            <option value="">{inheritLabel}</option>
            {cur.model && !known.has(cur.model) && <option value={cur.model}>{cur.model}</option>}
            {models.map((m) => <option key={m.value} value={m.value} title={m.description}>{m.displayName} ({m.value})</option>)}
          </select></td>
          <td><select value={cur.effort ?? ''} onChange={(e) => set(p, 'effort', e.target.value)}>
            <option value="">{inheritLabel}</option>{EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select></td>
        </tr>); })}
    </tbody></table>
  );
}
