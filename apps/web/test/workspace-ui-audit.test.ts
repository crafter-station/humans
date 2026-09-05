import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const workspaceDirectory = join(import.meta.dirname, "../app/workspace");
const workspaceSources = readdirSync(workspaceDirectory)
  .filter((file) => file.endsWith(".tsx"))
  .map(
    (file) =>
      [file, readFileSync(join(workspaceDirectory, file), "utf8")] as const,
  );

describe("workspace UI audit", () => {
  it("keeps the shared sidebar inset inside its flex container", () => {
    const sidebar = readFileSync(
      join(
        import.meta.dirname,
        "../../../packages/ui/src/components/sidebar.tsx",
      ),
      "utf8",
    );
    const inset = sidebar.slice(
      sidebar.indexOf("function SidebarInset"),
      sidebar.indexOf("function SidebarInput"),
    );

    expect(inset).toContain("min-w-0");
    expect(inset).not.toMatch(/className=\{cn\(\s*"[^"]*\bw-full\b/);
  });

  it("uses design-system controls instead of native or browser controls", () => {
    for (const [file, source] of workspaceSources) {
      expect(source, file).not.toMatch(/<(button|input|select|textarea)\b/);
      expect(source, file).not.toMatch(/window\.(prompt|confirm)\(/);
    }
  });

  it("does not replace design-system control chrome in workspace CSS", () => {
    const styles = readFileSync(
      join(workspaceDirectory, "workspace.module.css"),
      "utf8",
    );

    expect(styles).not.toMatch(
      /\b(button|input|select|textarea)(?=[:.\s,[>+~#])/,
    );
  });
});
