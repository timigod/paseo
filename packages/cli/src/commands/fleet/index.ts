import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import { addFleetRunOptions, runFleetRunCommand } from "./run.js";
import {
  addFleetFinishOptions,
  addFleetRecoverOptions,
  runFleetFinishCommand,
  runFleetRecoverCommand,
} from "./lifecycle.js";
import { runFleetDoctorCommand, runFleetStatusCommand } from "./status.js";

export function createFleetCommand(): Command {
  const fleet = new Command("fleet").description("Route and diagnose the configured Plexer fleet");

  addJsonOption(
    fleet.command("status").description("Show capacity and readiness across fleet hosts"),
  ).action(withOutput(runFleetStatusCommand));
  addJsonOption(
    fleet.command("doctor").description("Check fleet readiness without changing state"),
  ).action(withOutput(runFleetDoctorCommand));
  addJsonOption(addFleetRunOptions(fleet.command("run"))).action(withOutput(runFleetRunCommand));
  addJsonOption(addFleetFinishOptions(fleet.command("finish"))).action(
    withOutput(runFleetFinishCommand),
  );
  addJsonOption(addFleetRecoverOptions(fleet.command("recover"))).action(
    withOutput(runFleetRecoverCommand),
  );

  return fleet;
}
