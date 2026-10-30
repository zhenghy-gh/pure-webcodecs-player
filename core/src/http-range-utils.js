export function supportsByteRanges(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.replace(/^[ \t]+|[ \t]+$/g, '');
  if (!trimmed) return false;
  const units = trimmed.split(',').map((unit) => unit.replace(/^[ \t]+|[ \t]+$/g, ''));
  if (units.some((unit) => unit.toLowerCase() === 'none')) return false;
  if (units.some((unit) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(unit))) return false;
  return units.some((unit) => unit.toLowerCase() === 'bytes');
}
