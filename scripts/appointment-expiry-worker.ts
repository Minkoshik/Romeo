import "dotenv/config";
import { getDatabase } from "../src/lib/db";
import { expireAppointmentHolds } from "../src/lib/appointment-repository";
import { createAppointmentExpiryWorker } from "../src/lib/appointment-expiry-worker";

function main() {
  try {
    const database = getDatabase();
    const worker = createAppointmentExpiryWorker({ expire: () => expireAppointmentHolds(database), keepAlive: true });
    console.info("Проверка истекших броней запущена. Интервал: 30 секунд.");
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      console.info("Проверка истекших броней завершает работу.");
      const deadline = setTimeout(() => {
        console.error("Время завершения проверки броней истекло.");
        process.exit(1);
      }, 15_000);
      deadline.unref();
      void worker.stop().then(() => database.$disconnect()).then(() => {
        clearTimeout(deadline);
      }, () => {
        clearTimeout(deadline);
        console.error("Не удалось корректно завершить проверку броней.");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    console.error("Не удалось запустить проверку броней. Проверьте подключение к базе данных.");
    process.exitCode = 1;
  }
}

main();
