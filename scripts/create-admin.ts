import "dotenv/config";
import { stdin, stdout } from "node:process";
import { AdminError, provisionFirstAdmin } from "../src/lib/admin-auth";
import { getDatabase } from "../src/lib/db";

function argumentsFromCommand(): { email: string; name: string } {
  const args = process.argv.slice(2); const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (!["--email", "--name"].includes(args[index]) || !args[index + 1] || options.has(args[index])) throw new AdminError("Используйте: npm run admin:create -- --email owner@example.com --name \"Имя владельца\". Пароль вводится только скрыто в терминале.");
    options.set(args[index], args[index + 1]);
  }
  if (!options.get("--email") || !options.get("--name")) throw new AdminError("Укажите --email и --name. Пароль в аргументах или переменных окружения не принимается.");
  return { email: options.get("--email")!, name: options.get("--name")! };
}
function readHiddenPassword(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") throw new AdminError("Создание администратора требует интерактивный терминал со скрытым вводом пароля.");
  stdout.write(prompt);
  const previousRaw = stdin.isRaw;
  stdin.setRawMode(true); stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    function cleanup() { stdin.off("data", data); stdin.setRawMode(previousRaw); stdin.pause(); stdout.write("\n"); }
    function data(chunk: Buffer) {
      const input = chunk.toString("utf8");
      if (input.includes("\u001b")) return;
      for (const character of input) {
        if (character === "\r" || character === "\n") { cleanup(); resolve(value); return; }
        if (character === "\u0003" || character === "\u0004") { value = ""; cleanup(); reject(new AdminError("Создание администратора отменено.")); return; }
        if (character === "\u007f" || character === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (character === "\u0015") value = "";
        else if (character >= " " && value.length <= 256) value += character;
      }
    }
    stdin.on("data", data);
  });
}
async function main() {
  const input = argumentsFromCommand();
  const database = getDatabase();
  try {
    if (await database.adminUser.count()) { console.info("Администратор уже существует. Команда не изменяет пароль и права существующих аккаунтов."); return; }
    const password = await readHiddenPassword("Пароль (12–256 символов, ввод скрыт): ");
    const confirmation = await readHiddenPassword("Повторите пароль (ввод скрыт): ");
    if (password !== confirmation) throw new AdminError("Пароли не совпадают. Аккаунт не создан.");
    const result = await provisionFirstAdmin({ ...input, password }, { database });
    console.info(result.created ? "Первый владелец создан. Войдите на /admin/login с указанным email и паролем." : "Администратор уже существует. Данные не изменены.");
  } finally { await database.$disconnect(); }
}
main().catch((error: unknown) => { console.error(error instanceof AdminError ? error.message : "Создание администратора не завершено. Проверьте миграции и подключение к базе."); process.exitCode = 1; });
