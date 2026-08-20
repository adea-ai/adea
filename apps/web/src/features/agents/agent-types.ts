export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  status: "active" | "idle" | "waiting";
  task: string;
  color: string;
}

export const agentFixtures: AgentSummary[] = [
  {
    id: "agent-1",
    name: "Atlas",
    role: "Research lead",
    status: "active",
    task: "Mapping the launch brief",
    color: "#86efac",
  },
  {
    id: "agent-2",
    name: "Mira",
    role: "Product strategist",
    status: "waiting",
    task: "Reviewing the next decision",
    color: "#fcd34d",
  },
  {
    id: "agent-3",
    name: "Coda",
    role: "Implementation partner",
    status: "idle",
    task: "Ready for a new assignment",
    color: "#93c5fd",
  },
];
