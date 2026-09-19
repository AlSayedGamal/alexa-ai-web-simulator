/**
 * Limit how much text is sent to a metered provider. Cuts at the last sentence
 * end before `max` (so the voice doesn't stop mid-sentence), else the last
 * space, else hard at `max`.
 */
export function capText(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;

  const head = trimmed.slice(0, max);
  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (sentenceEnd > max * 0.4) return head.slice(0, sentenceEnd + 1);

  const space = head.lastIndexOf(" ");
  return (space > max * 0.4 ? head.slice(0, space) : head).trimEnd();
}
