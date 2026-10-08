export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { startAppointmentExpiryWorker } = await import("./lib/appointment-expiry-worker");
  // The first tick runs in the background: a database outage cannot prevent the
  // server from starting and displaying its normal recoverable error state.
  startAppointmentExpiryWorker();
}
