import { expect, it } from "vitest";
import { createCli } from "../../cli.js";

it("exposes the focused fleet control surface", () => {
  const fleet = createCli().commands.find((command) => command.name() === "fleet");

  expect(fleet?.commands.map((command) => command.name())).toEqual([
    "status",
    "doctor",
    "run",
    "finish",
    "recover",
    "continue",
  ]);
  const runHelp = fleet?.commands.find((command) => command.name() === "run")?.helpInformation();
  expect(runHelp).toContain("--prompt-file <path>");
  expect(runHelp).toContain("--host <host>");
  expect(runHelp).toContain("--idempotency-key <key>");
  expect(runHelp).toContain("--auto-archive");
});
