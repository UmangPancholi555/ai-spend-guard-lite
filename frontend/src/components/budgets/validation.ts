/** Limit is a positive USD decimal string with at most 12 fraction digits. Never converted to a float. */
export function validateLimit(v: string): string | null {
  const s = v.trim();
  if (!s) return 'Limit is required.';
  if (!/^\d{1,15}(\.\d{1,12})?$/.test(s)) {
    if (/^\d+\.\d{13,}$/.test(s)) return 'Limit can have at most 12 decimal places.';
    return 'Limit must be a plain positive decimal like 25 or 0.5 (no signs, commas or exponents).';
  }
  if (!/[1-9]/.test(s)) return 'Limit must be greater than zero.';
  return null;
}
export function validateName(v: string): string | null {
  const s = v.trim();
  if (!s) return 'Name is required.';
  if (s.length > 80) return 'Name must be 80 characters or fewer.';
  return null;
}
