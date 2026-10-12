/** Keep invalid numbers out of JSON, where NaN and Infinity become null. */
export function adminFormNumber(value: string, { scale = 1, emptyAsNull = false }: { scale?: number; emptyAsNull?: boolean } = {}): number | null {
  if (!value.trim() && emptyAsNull) return null;
  const amount = Number(value);
  const scaled = amount * scale;
  const rounded = Math.round(scaled);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 0.000001) {
    throw new Error("Укажите корректное число с допустимой точностью.");
  }
  return rounded;
}
