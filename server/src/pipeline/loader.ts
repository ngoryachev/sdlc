import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { PipelineSchema, type PipelineSpec } from './schema.js';

export interface LoadedPipeline {
  spec: PipelineSpec;
  /** Directory the pipeline file lives in; prompt/schema paths resolve relative to its parent (repo root) then to itself. */
  baseDir: string;
  filePath: string;
}

export function findPipelineFile(nameOrPath: string, searchDirs: string[]): string {
  if (nameOrPath.endsWith('.yaml') || nameOrPath.endsWith('.yml')) {
    const abs = path.resolve(nameOrPath);
    if (fs.existsSync(abs)) return abs;
    throw new Error(`pipeline file not found: ${nameOrPath}`);
  }
  for (const d of searchDirs) {
    for (const ext of ['.yaml', '.yml']) {
      const p = path.join(d, nameOrPath + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error(`pipeline "${nameOrPath}" not found in ${searchDirs.join(', ')}`);
}

export function loadPipeline(filePath: string): LoadedPipeline {
  const raw = YAML.parse(fs.readFileSync(filePath, 'utf8'));
  const parsed = PipelineSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`).join('\n');
    throw new Error(`invalid pipeline ${filePath}:\n${msg}`);
  }
  return { spec: parsed.data, baseDir: path.dirname(filePath), filePath };
}

/** Resolve a file referenced from a pipeline (prompt, schema): relative to the sdlc root (parent of pipelines/) first, then to the pipeline dir. */
export function resolvePipelineFile(lp: LoadedPipeline, rel: string): string {
  if (path.isAbsolute(rel)) return rel;
  const candidates = [path.join(path.dirname(lp.baseDir), rel), path.join(lp.baseDir, rel)];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`pipeline ${lp.spec.name}: file not found: ${rel} (looked in ${candidates.join(', ')})`);
}

export function phaseIndex(spec: PipelineSpec, name: string): number {
  const i = spec.phases.findIndex((p) => p.name === name);
  if (i < 0) throw new Error(`unknown phase: ${name}`);
  return i;
}
