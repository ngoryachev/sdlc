import { useMemo } from 'react';
import { html as diff2html } from 'diff2html';
import { createTwoFilesPatch } from 'diff';

export function DiffView({ patch }: { patch: string }) {
  const side = typeof window !== 'undefined' && window.innerWidth > 900;
  const out = useMemo(() => patch.trim() ? diff2html(patch, { drawFileList: true, matching: 'lines', outputFormat: side ? 'side-by-side' : 'line-by-line' }) : '', [patch, side]);
  if (!patch.trim()) return <div className="muted">no changes</div>;
  return <div dangerouslySetInnerHTML={{ __html: out }} />;
}

export function EditDiff({ file, oldStr, newStr }: { file: string; oldStr: string; newStr: string }) {
  const patch = useMemo(() => createTwoFilesPatch(file, file, oldStr, newStr, '', '', { context: 3 }), [file, oldStr, newStr]);
  return <DiffView patch={patch} />;
}
