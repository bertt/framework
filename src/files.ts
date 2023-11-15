import {type Stats} from "node:fs";
import {mkdir, readdir, stat} from "node:fs/promises";
import {dirname, extname, join, normalize, relative} from "node:path";
import {isNodeError} from "./error.js";

// A path is local if it doesn’t go outside the the root.
export function getLocalPath(sourcePath: string, name: string): string | null {
  if (/^\w+:/.test(name)) return null; // URL
  const path = join(dirname(sourcePath.startsWith("/") ? sourcePath.slice("/".length) : sourcePath), name);
  if (path.startsWith("../")) return null; // goes above root
  return path;
}

export async function* visitMarkdownFiles(root: string): AsyncGenerator<string> {
  for await (const file of visitFiles(root)) {
    if (extname(file) !== ".md") continue;
    yield file;
  }
}

export async function* visitFiles(root: string): AsyncGenerator<string> {
  const visited = new Set<number>();
  const queue: string[] = [(root = normalize(root))];
  for (const path of queue) {
    const status = await stat(path);
    if (status.isDirectory()) {
      if (visited.has(status.ino)) throw new Error(`Circular directory: ${path}`);
      visited.add(status.ino);
      for (const entry of await readdir(path)) {
        queue.push(join(path, entry));
      }
    } else {
      yield relative(root, path);
    }
  }
}

// Like fs.stat, but returns undefined instead of throwing ENOENT if not found.
export async function maybeStat(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

export async function prepareOutput(outputPath: string): Promise<void> {
  const outputDir = dirname(outputPath);
  if (outputDir === ".") return;
  await mkdir(outputDir, {recursive: true});
}
