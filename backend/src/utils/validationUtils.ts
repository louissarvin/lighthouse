import type { FastifyReply } from 'fastify';

export const validateRequiredFields = async (
  body: Record<string, unknown> | null | undefined,
  fields: string[],
  reply: FastifyReply
): Promise<true | FastifyReply> => {
  if (!Array.isArray(fields) || fields.length === 0) {
    return reply.code(400).send({ error: 'Fields array is empty or undefined' });
  }

  if (!body || Object.keys(body).length === 0) {
    return reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Request body is empty or undefined',
    });
  }

  const missingParams = fields.reduce<string[]>((acc, field) => {
    // Check for undefined, null, or empty string
    return body[field] === undefined || body[field] === null || body[field] === ''
      ? [...acc, field]
      : acc;
  }, []);

  if (missingParams.length > 0) {
    return reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: `Missing parameters: ${missingParams.join(', ')}`,
    });
  }

  return true;
};

/**
 * Validate that a string looks like a valid Sui address (0x + 64 hex chars).
 */
export function isValidSuiAddress(addr: unknown): addr is string {
  return typeof addr === 'string' && /^0x[0-9a-f]{64}$/i.test(addr);
}

/**
 * Validate a positive integer (e.g. quantity in DUSDC units).
 * Returns true for any `number | bigint | string` that is a positive integer.
 */
export function isPositiveInteger(val: unknown): boolean {
  if (typeof val === 'number') return Number.isInteger(val) && val > 0;
  if (typeof val === 'bigint') return val > 0n;
  if (typeof val === 'string') {
    const n = Number(val);
    return Number.isFinite(n) && Number.isInteger(n) && n > 0;
  }
  return false;
}

/**
 * Validate that a value is a non-empty string.
 */
export function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0;
}
