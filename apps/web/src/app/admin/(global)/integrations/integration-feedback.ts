type IntegrationProblem = { detail?: string; title?: string } | undefined;

export function safeIntegrationProblemMessage(
  problem: IntegrationProblem,
  fallback: string,
  sensitiveValues: Record<string, unknown> = {},
): string {
  const message = problem?.detail ?? problem?.title ?? fallback;
  const containsSensitiveValue = Object.values(sensitiveValues).some(
    (value) =>
      typeof value === 'string' &&
      value.length > 0 &&
      message.includes(value),
  );
  return containsSensitiveValue ? fallback : message;
}
