import { problemMessage } from '@weavestream/shared';

export function safeIntegrationProblemMessage(
  problem: unknown,
  fallback: string,
  sensitiveValues: Record<string, unknown> = {},
): string {
  const message = problemMessage(problem) ?? fallback;
  const containsSensitiveValue = Object.values(sensitiveValues).some(
    (value) =>
      typeof value === 'string' &&
      value.length > 0 &&
      message.includes(value),
  );
  return containsSensitiveValue ? fallback : message;
}
