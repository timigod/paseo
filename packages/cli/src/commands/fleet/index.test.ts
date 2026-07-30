import { expect, it } from "vitest";
import { createCli } from "../../cli.js";

it("exposes a single fleet control surface with status, doctor, and run", () => {
  const fleet = createCli().commands.find((command) => command.name() === "fleet");

  expect(fleet?.commands.map((command) => command.name())).toEqual([
    "status",
    "doctor",
    "run",
    "finish",
    "recover",
    "continue",
  ]);
  expect(fleet?.commands.find((command) => command.name() === "run")?.helpInformation()).toContain(
    "--host <host>",
  );
});
