import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDirectory = join(packageDirectory, "drizzle");

const runDrizzleKit = (...arguments_) => {
  const result = spawnSync("bun", ["x", "drizzle-kit", ...arguments_], {
    cwd: packageDirectory,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

// Drizzle has no schema primitive for extensions, so generate its custom
// migration from this declaration instead of editing migration SQL by hand.
if (!existsSync(join(migrationsDirectory, "meta", "_journal.json"))) {
  runDrizzleKit("generate", "--custom", "--name=extensions");

  const [extensionMigration] = readdirSync(migrationsDirectory).filter((file) =>
    file.endsWith("_extensions.sql"),
  );

  if (extensionMigration === undefined) {
    throw new Error("Drizzle Kit did not generate the extension migration");
  }

  const extensions = ["vector"];
  writeFileSync(
    join(migrationsDirectory, extensionMigration),
    `${extensions
      .map((extension) => `CREATE EXTENSION IF NOT EXISTS "${extension}";`)
      .join("\n")}\n`,
  );
}

runDrizzleKit("generate", "--name=initial");
