import type {
  AgentRuntimeCapacityController,
  AgentRuntimeCapacityReservation,
  AgentRuntimeCapacitySnapshot,
} from "./agent-sdk-types.js";

export class AgentRuntimeCapacityError extends Error {
  constructor(
    public readonly limit: number,
    public readonly live: number,
    public readonly reserved: number,
  ) {
    super(
      `Host agent runtime capacity reached (limit: ${limit}, live: ${live}, starting: ${reserved}). Close an agent or increase daemon.maxActiveAgentRuntimes.`,
    );
    this.name = "AgentRuntimeCapacityError";
  }
}

export class HostAgentRuntimeCapacityController implements AgentRuntimeCapacityController {
  private readonly liveRuntimes = new Set<object>();
  private reservations = 0;

  constructor(private readonly limit: number | null) {
    if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
      throw new RangeError("maxActiveAgentRuntimes must be a positive integer");
    }
  }

  getAvailableRuntimeSlots(): number | null {
    if (this.limit === null) {
      return null;
    }
    return Math.max(this.limit - this.liveRuntimes.size - this.reservations, 0);
  }

  getSnapshot(): AgentRuntimeCapacitySnapshot {
    return {
      limit: this.limit,
      live: this.liveRuntimes.size,
      starting: this.reservations,
      available: this.getAvailableRuntimeSlots(),
    };
  }

  reserve(): AgentRuntimeCapacityReservation {
    const live = this.liveRuntimes.size;
    const reserved = this.reservations;
    if (this.limit !== null && live + reserved >= this.limit) {
      throw new AgentRuntimeCapacityError(this.limit, live, reserved);
    }

    this.reservations += 1;
    let active = true;
    const finishReservation = () => {
      if (!active) return false;
      active = false;
      this.reservations -= 1;
      return true;
    };

    return {
      track: (runtime) => {
        if (!finishReservation()) {
          throw new Error("Agent runtime capacity reservation has already been settled");
        }
        this.liveRuntimes.add(runtime);
      },
      release: () => {
        finishReservation();
      },
    };
  }

  release(runtime: object): void {
    this.liveRuntimes.delete(runtime);
  }
}

export const UNMANAGED_AGENT_RUNTIME_RESERVATION: AgentRuntimeCapacityReservation = {
  track: () => undefined,
  release: () => undefined,
};

export async function withTemporaryRuntimeCapacity<T>(
  controller: AgentRuntimeCapacityController | null | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const reservation = controller?.reserve() ?? UNMANAGED_AGENT_RUNTIME_RESERVATION;
  try {
    return await operation();
  } finally {
    reservation.release();
  }
}
