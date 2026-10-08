export type AvailabilityPolicy = {
  bookingHorizonDays: number;
  minimumLeadMinutes: number;
  slotStepMinutes: number;
};

export type WorkingInterval = { startMinute: number; endMinute: number };
export type WeeklyInterval = WorkingInterval & { dayOfWeek: number };
export type ExceptionInterval = WorkingInterval & { kind: "WORKING" | "BLOCKED" };
export type ExceptionRow = {
  date: string;
  kind: "CLOSED_DAY" | "REPLACE_DAY" | "BLOCKS_ONLY";
  intervals: ExceptionInterval[];
};
export type OccupiedInterval = { startAt: Date | string; endAt: Date | string };
export type AvailabilityInput = {
  timezone: string;
  policy: AvailabilityPolicy;
  durationMinutes: number;
  bufferMinutes: number;
  weeklyIntervals: WeeklyInterval[];
  exceptionRows: ExceptionRow[];
  /** endAt includes the already reserved technical buffer. */
  occupied: OccupiedInterval[];
  date?: string;
  now?: Date;
};

export type AvailabilitySlot = {
  time: string;
  endTime: string;
  startAt: string;
  endAt: string;
  blockedUntil: string;
  status: "available" | "past" | "closed" | "busy";
  reason: string;
};
export type AvailabilityDay = {
  date: string;
  status: "available" | "past" | "closed" | "full";
  reason: string;
  availableCount: number;
};
export type AvailabilityResult = {
  today: string;
  lastDate: string;
  date: string;
  days: AvailabilityDay[];
  slots: AvailabilitySlot[];
  nearest: { date: string; slot: AvailabilitySlot } | null;
};

export type DatabaseAvailability = AvailabilityResult & {
  source: "database";
  generatedAt: string;
  timezone: string;
  masterId: string;
  totalPriceMinor: number;
  totalDurationMinutes: number;
  totalBufferMinutes: number;
};
