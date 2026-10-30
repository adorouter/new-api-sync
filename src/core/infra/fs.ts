import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Atomic write: tmp + rename so a SIGKILL mid-write leaves the previous file intact. */
export function writeJsonAtomic(
  path: string,
  data: unknown,
  opts: { pretty?: boolean } = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(
    tmp,
    opts.pretty === false
      ? JSON.stringify(data)
      : JSON.stringify(data, null, 2),
  );
  renameSync(tmp, path);
}
