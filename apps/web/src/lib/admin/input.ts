import { z } from 'zod';
import { AdminError } from './types';

/** Validates action input; the first problem becomes a user-facing AdminError. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = issue?.path.join('.');
    throw new AdminError(field ? `${field}: ${issue?.message}` : (issue?.message ?? 'Invalid input.'));
  }
  return r.data;
}

/** FormData → plain object (last value wins; files ignored). */
export function formObject(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v;
  return out;
}

export const id = z.uuid({ message: 'invalid id' });
/** '' (an unselected <select>) → null. */
export const optionalId = z.preprocess((v) => (v === '' || v === undefined ? null : v), z.uuid({ message: 'invalid id' }).nullable());
export const name = (max = 80) => z.string().trim().min(1, 'required').max(max, `at most ${max} characters`);
export const teamRole = z.enum(['member', 'lead']);
export const companyRole = z.enum(['admin', 'member']);
