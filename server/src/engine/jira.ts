/**
 * The Jira issue key of a task: read once from its prompt, then carried into the branch name, the published pull
 * request title and every commit subject sdlc writes. Own module (not engine.ts) so the git phases can use it too.
 */

/** `\b[A-Z][A-Z0-9]+-\d+\b` matches plenty of things that are not issue keys; these prefixes are the common ones. */
const NOT_JIRA = new Set([
  'UTF', 'UTF8', 'SHA', 'SHA1', 'SHA2', 'SHA3', 'MD5', 'ISO', 'CVE', 'GPT', 'HTTP', 'HTTPS', 'RFC', 'UTC',
  'AES', 'RSA', 'RGB', 'RGBA', 'ASCII', 'TLS', 'SSL', 'BASE', 'IPV4', 'IPV6', 'COVID',
  'PEP', 'IEEE', 'X86', 'ARM64', 'Q1', 'Q2', 'Q3', 'Q4',
]);

const KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;

/**
 * First issue key in a text, case preserved (it must never pass through a slug generator), or null. Matches that
 * look like a standard or an algorithm rather than a project key (`UTF-8`, `SHA-256`, `CVE-2024`) are skipped.
 */
export function jiraKeyFrom(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const m of text.matchAll(KEY_RE)) {
    const key = m[0];
    if (!NOT_JIRA.has(key.slice(0, key.lastIndexOf('-')))) return key;
  }
  return null;
}

/**
 * `<KEY> <subject>`, unless there is no key or the subject line already carries it. Only the first line counts: a
 * key that a custom message mentions in a trailer still belongs in front of the subject. The word boundaries keep
 * `PROJ-7` from hiding behind a `PROJ-70` in the text; a key from `jiraKeyFrom` has no regexp metacharacters.
 */
export function withJiraKey(subject: string, key: string | null | undefined): string {
  if (!key) return subject;
  const subjectLine = subject.split('\n', 1)[0]!;
  return new RegExp(`\\b${key}\\b`).test(subjectLine) ? subject : `${key} ${subject}`;
}
