import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPaseoLaunchAgentPlist,
  reconcilePaseoLaunchAgent,
  resolvePaseoLaunchAgentPath,
} from "./launch-agent";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "paseo-launch-agent-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Paseo launch agent", () => {
  it("uses the packaged launcher that resolves a login-shell PATH per service start", () => {
    const plist = createPaseoLaunchAgentPlist({
      home: "/Users/timi",
      resourcesPath: "/Applications/Paseo.app/Contents/Resources",
    });

    expect(plist).toContain(
      "<string>/Applications/Paseo.app/Contents/Resources/bin/paseo-daemon-launcher</string>",
    );
    expect(plist).not.toContain("<key>PATH</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });

  it("updates only the owned service file atomically", () => {
    const home = tempRoot();
    const filePath = resolvePaseoLaunchAgentPath(home);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      createPaseoLaunchAgentPlist({
        home,
        resourcesPath: "/Applications/Paseo.app/Contents/Resources",
      }),
    );

    const first = reconcilePaseoLaunchAgent({
      home,
      resourcesPath: "/Applications/Paseo.app/Contents/Resources",
      platform: "darwin",
    });
    expect(first).toEqual({ path: filePath, changed: false });

    const second = reconcilePaseoLaunchAgent({
      home,
      resourcesPath: "/Applications/Paseo Next.app/Contents/Resources",
      platform: "darwin",
    });
    expect(second).toEqual({ path: filePath, changed: true });
    expect(readFileSync(filePath, "utf8")).toContain(
      "/Applications/Paseo Next.app/Contents/Resources/bin/paseo-daemon-launcher",
    );
  });

  it("refuses to overwrite an unrelated launch agent", () => {
    const home = tempRoot();
    const filePath = resolvePaseoLaunchAgentPath(home);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "<plist><dict><key>Label</key><string>other</string></dict></plist>");

    expect(() =>
      reconcilePaseoLaunchAgent({
        home,
        resourcesPath: "/Applications/Paseo.app/Contents/Resources",
        platform: "darwin",
      }),
    ).toThrow(`refusing to overwrite unmanaged LaunchAgent at ${filePath}`);
  });
});
