export type ExperimentAgent = {
  pubkey: string;
  status: string;
  backend: { type: string };
};

export type ExperimentToggleDependencies = {
  setBackend: (enabled: boolean) => Promise<void>;
  listAgents: () => Promise<ExperimentAgent[]>;
  stopAgent: (pubkey: string) => Promise<unknown>;
  startAgent: (pubkey: string) => Promise<unknown>;
  setUi: (enabled: boolean) => void;
};

async function restartRunningLocalAgents(
  agents: ExperimentAgent[],
  deps: ExperimentToggleDependencies,
): Promise<void> {
  for (const agent of agents) {
    if (agent.status !== "running" || agent.backend.type !== "local") continue;
    await deps.stopAgent(agent.pubkey);
    await deps.startAgent(agent.pubkey);
  }
}

/**
 * Apply the Rust-owned experiment and restart affected processes. The UI is
 * committed only after every restart succeeds. On failure, both persisted
 * backend state and already-restarted agents are restored best-effort.
 */
export async function applyAcpTopLevelSessionsExperiment(
  previous: boolean,
  next: boolean,
  deps: ExperimentToggleDependencies,
): Promise<void> {
  const agents = await deps.listAgents();
  try {
    await deps.setBackend(next);
    await restartRunningLocalAgents(agents, deps);
    deps.setUi(next);
  } catch (error) {
    try {
      await deps.setBackend(previous);
    } catch (rollbackError) {
      console.error(
        "Failed to roll back ACP top-level sessions backend state",
        rollbackError,
      );
    }
    for (const agent of agents) {
      if (agent.status !== "running" || agent.backend.type !== "local")
        continue;
      try {
        await deps.stopAgent(agent.pubkey);
        await deps.startAgent(agent.pubkey);
      } catch (rollbackError) {
        console.error(
          `Failed to roll back ACP experiment process ${agent.pubkey}`,
          rollbackError,
        );
      }
    }
    deps.setUi(previous);
    throw error;
  }
}
