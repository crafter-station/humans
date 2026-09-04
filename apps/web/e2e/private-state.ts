import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const privateFileExists = (file: string) => existsSync(file);

export const readPrivateJson = (file: string): unknown => {
  if (!existsSync(file)) return null;
  if ((statSync(file).mode & 0o777) !== 0o600) {
    throw new Error("Browser acceptance state must have mode 600");
  }
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error("Browser acceptance state is not valid JSON");
  }
};

export const writePrivateJsonAtomically = (file: string, value: unknown) => {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryFile, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryFile, 0o600);
    renameSync(temporaryFile, file);
    chmodSync(file, 0o600);
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryFile, { force: true });
  }
};

export const removePrivateFile = (file: string) =>
  rmSync(file, { force: true });
