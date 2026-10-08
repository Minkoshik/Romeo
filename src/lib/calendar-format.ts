export function escapeCalendarText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

export function calendarTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Некорректное время календарного события");
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function foldCalendarLine(line: string): string[] {
  const folded: string[] = [];
  const encoder = new TextEncoder();
  let chunk = "";
  let bytes = 0;
  for (const symbol of line) {
    const size = encoder.encode(symbol).length;
    if (bytes + size > 75) { folded.push(chunk); chunk = " "; bytes = 1; }
    chunk += symbol; bytes += size;
  }
  folded.push(chunk);
  return folded;
}
