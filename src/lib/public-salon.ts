import "server-only";
import { cache } from "react";
import { loadDatabaseCatalog } from "./catalog-repository";
import { getSalon } from "./salon";

// Shared only within a server render. A DB outage still permits the recoverable
// client error screen; it never substitutes a file catalog or available slots.
export const getPublicSalon = cache(async () => {
  try { return (await loadDatabaseCatalog()).salon ?? getSalon(); }
  catch { return getSalon(); }
});
