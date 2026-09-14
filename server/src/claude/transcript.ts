import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** Append-only JSONL writer, one SDK message per line. */
export class TranscriptWriter {
  private stream: fs.WriteStream;
  private lines = 0;
  constructor(public readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
  }
  write(obj: unknown): number {
    this.stream.write(JSON.stringify(obj) + '\n');
    return this.lines++;
  }
  get lineCount() { return this.lines; }
  async close(): Promise<void> {
    await new Promise<void>((res, rej) => this.stream.end((e?: Error | null) => (e ? rej(e) : res())));
  }
}

export async function readTranscript(filePath: string, from = 0, limit = 500): Promise<{ lines: unknown[]; next: number; eof: boolean }> {
  if (!fs.existsSync(filePath)) return { lines: [], next: from, eof: true };
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  const out: unknown[] = [];
  let idx = 0;
  let eof = true;
  for await (const line of rl) {
    if (idx >= from) {
      if (out.length >= limit) { eof = false; break; }
      if (line.trim()) { try { out.push(JSON.parse(line)); } catch { out.push({ type: 'sdlc.unparsable', raw: line }); } }
    }
    idx++;
  }
  rl.close();
  return { lines: out, next: from + out.length, eof };
}
