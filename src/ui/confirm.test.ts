import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every .ts/.tsx file under src, except tests and this helper. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) return [];
    if (path.endsWith(join("ui", "confirm.ts"))) return [];
    return [path];
  });
}

describe("confirmation boxes", () => {
  // The dialog plugin replaces window.confirm with an async version. Its
  // Promise is always truthy, so `if (confirm(...))` goes ahead without
  // waiting for the answer — a delete or a restore with no question asked.
  it("no screen calls the browser's confirm(); they await askToConfirm()", () => {
    const offenders = sourceFiles("src").filter((file) =>
      /(^|[^\w.])confirm\(/m.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
