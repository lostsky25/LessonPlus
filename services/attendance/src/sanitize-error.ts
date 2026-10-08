export function sanitizeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown';
  return text
    .replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://***')
    .replace(/amqps?:\/\/\S+/gi, 'amqp://***');
}
