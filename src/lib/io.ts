import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const dataPath = (file: string): string => `data/${file}`;

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf-8")) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

export const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );
