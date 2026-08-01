/**
 * Flattens an error into one readable line.
 *
 * Network failures arrive wrapped: Node raises an `AggregateError` with an empty
 * message when a dual-stack connect fails, and driver libraries nest the real
 * cause. Reading `.message` alone yields `""` or `"Failed query: ..."`, neither
 * of which tells an operator what broke.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const parts: string[] = [];
  const seen = new Set<Error>();
  let current: Error | undefined = err;

  while (current !== undefined && !seen.has(current)) {
    seen.add(current);

    const code = (current as { code?: unknown }).code;
    const label =
      current.message.trim().replace(/\s+/g, ' ') ||
      (typeof code === 'string' ? code : current.name);

    if (label !== '' && !parts.includes(label)) parts.push(label);

    // Prefer the first aggregated error (the dual-stack case), else the cause.
    const next: unknown =
      current instanceof AggregateError && current.errors.length > 0
        ? current.errors[0]
        : current.cause;

    current = next instanceof Error ? next : undefined;
  }

  return parts.join(': ') || err.name;
}
