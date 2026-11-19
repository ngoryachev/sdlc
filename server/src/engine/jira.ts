/**
 * The Jira issue key of a task: read once from its prompt, then carried into the branch name, the published pull
 * request title and every commit subject sdlc writes. Own module (not engine.ts) so the git phases can use it too.
 */

/** `\b[A-Z][A-Z0-9]+-\d+\b` matches plenty of things that are not issue keys; these prefixes are the common ones. */
const NOT_JIRA = new Set([
  'UTF', 'UTF8', 'SHA', 'SHA1', 'SHA2', 'MD5', 'ISO', 'CVE', 'GPT', 'HTTP', 'HTTPS', 'RFC', 'UTC',
  'AES', 'RSA', 'RGB', 'RGBA', 'ASCII', 'TLS', 'SSL', 'BASE', 'IPV4', 'IPV6', 'COVID',
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

/** `<KEY> <subject>`, unless there is no key or the subject already carries it. */
export function withJiraKey(subject: string, key: string | null | undefined): string {
  if (!key || subject.includes(key)) return subject;
  return `${key} ${subject}`;
}
