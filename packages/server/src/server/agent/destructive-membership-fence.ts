export interface DestructiveMembershipVersionSource {
  readonly name: string;
  readonly getVersion: () => number;
}

export interface DestructiveMembershipFence {
  readonly versions: ReadonlyMap<string, number>;
}

export class DestructiveMembershipChangedError extends Error {
  constructor(sourceName: string) {
    super(`Destructive target membership changed during execution (${sourceName})`);
    this.name = "DestructiveMembershipChangedError";
  }
}

export function captureDestructiveMembershipFence(
  sources: readonly DestructiveMembershipVersionSource[],
): DestructiveMembershipFence {
  return {
    versions: new Map(sources.map((source) => [source.name, source.getVersion()])),
  };
}

export function assertDestructiveMembershipFence(
  fence: DestructiveMembershipFence,
  sources: readonly DestructiveMembershipVersionSource[],
): void {
  for (const source of sources) {
    if (fence.versions.get(source.name) !== source.getVersion()) {
      throw new DestructiveMembershipChangedError(source.name);
    }
  }
}
