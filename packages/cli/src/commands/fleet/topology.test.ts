import { describe, expect, it } from "vitest";
import {
  FLEET_HOSTS,
  findFleetHost,
  findFleetHostForCwd,
  findFleetHostForHostname,
  translateFleetCwd,
} from "./topology.js";

describe("fleet topology", () => {
  it("recognises configured hosts by id, endpoint, hostname, and code root", () => {
    expect(findFleetHost("IMAC")?.id).toBe("imac");
    expect(findFleetHost("100.108.191.125:6767")?.id).toBe("macbook");
    expect(findFleetHostForHostname("iMac.local")?.id).toBe("imac");
    expect(findFleetHostForCwd("/Users/timiajiboye/Code/backoffice")?.id).toBe("macbook");
    expect(findFleetHostForCwd("/private/tmp/paseo")).toBeNull();
  });

  it("translates a source-tree cwd to its peer without changing its relative path", () => {
    const macbook = FLEET_HOSTS.find((host) => host.id === "macbook")!;
    const imac = FLEET_HOSTS.find((host) => host.id === "imac")!;

    expect(
      translateFleetCwd("/Users/timiajiboye/Code/backoffice/packages/api", macbook, imac),
    ).toBe("/Users/timi/Code/backoffice/packages/api");
  });

  it("refuses to translate a cwd outside the declared source root", () => {
    const macbook = FLEET_HOSTS.find((host) => host.id === "macbook")!;
    const imac = FLEET_HOSTS.find((host) => host.id === "imac")!;

    expect(() => translateFleetCwd("/Users/timiajiboye/Documents/private", macbook, imac)).toThrow(
      /outside the macbook fleet code root/,
    );
  });
});
