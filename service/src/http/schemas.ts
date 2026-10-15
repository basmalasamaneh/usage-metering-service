import { z } from 'zod';
import { HttpError, badRequest } from './errors';

/** Upper bound for allowances and request sizes: keeps every counter far inside the safe-integer range. */
export const MAX_UNITS = 1_000_000_000_000;

const identifier = z
  .string()
  .regex(/^[A-Za-z0-9_.:@+-]{1,128}$/, 'must be 1-128 characters from A-Z a-z 0-9 _ . : @ + -');

const limitValue = z.number().int().min(0).max(MAX_UNITS).nullable();
const planName = z.string().trim().min(1).max(100);

export const createAccountBody = z.object({ name: z.string().trim().min(1).max(200), planId: z.string().min(1).max(100).optional() }).strict();
export const setPlanBody = z.object({ planId: z.string().min(1).max(100) }).strict();

export const createUserBody = z.object({ userId: identifier, planId: z.string().min(1).max(100).optional() }).strict();
export const userIdParam = z.object({ userId: identifier });
export const requestIdParam = z.object({ requestId: identifier });

export const createPlanBody = z
  .object({
    scope: z.enum(['account', 'user']),
    name: planName,
    monthlyAllowance: limitValue.default(null),
    maxUnitsPerRequest: limitValue.default(null),
  })
  .strict();
export const updatePlanBody = z
  .object({ name: planName.optional(), monthlyAllowance: limitValue.optional(), maxUnitsPerRequest: limitValue.optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'at least one field is required');
export const planListQuery = z.object({ scope: z.enum(['account', 'user']).optional() });

export const consumeBody = z
  .object({
    userId: identifier,
    units: z.number({ invalid_type_error: 'units must be a number' }).int('units must be a whole number').positive('units must be positive').max(MAX_UNITS),
    requestId: identifier,
  })
  .strict();

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must look like YYYY-MM');
const limit = z.coerce.number().int().min(1).max(200).default(50);
const cursor = z.string().min(1).max(100).optional();

export const usageQuery = z.object({ month: month.optional(), limit, cursor });
export const userUsageQuery = z.object({ month: month.optional() });
export const monthsQuery = z.object({ limit: z.coerce.number().int().min(1).max(120).default(24) });
export const pageQuery = z.object({ limit, cursor });
export const historyQuery = z.object({
  userId: identifier.optional(),
  month: month.optional(),
  outcome: z.enum(['accepted', 'rejected']).optional(),
  limit,
  cursor,
});

/** Parses and returns typed data, or throws a 400 listing every problem. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const res = schema.safeParse(data ?? {});
  if (res.success) return res.data;
  const issues = res.error.issues.map((i) => ({ path: i.path.join('.') || '(body)', message: i.message }));
  throw new HttpError(400, 'validation_error', `Invalid request: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`, issues);
}

// Opaque cursors: base64url of the last seen numeric key.
export const encodeCursor = (n: number): string => Buffer.from(String(n)).toString('base64url');
export function decodeCursor(c: string | undefined): number | null {
  if (c === undefined) return null;
  const decoded = /^[A-Za-z0-9_-]+$/.test(c) ? Buffer.from(c, 'base64url').toString() : '';
  // Strict: only a cursor we produced (digits, round-trips to the same string) is accepted.
  if (!/^\d{1,15}$/.test(decoded) || encodeCursor(Number(decoded)) !== c) throw badRequest('cursor is invalid');
  return Number(decoded);
}
