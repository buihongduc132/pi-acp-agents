import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureRuntimeDir } from "./runtime-paths.js";

export interface PlanApprovalRequest {
  agent: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  resolvedAt?: string;
  feedback?: string;
}

export interface ModelPolicyState {
  allowedModels: string[];
  blockedModels: string[];
  requireProviderPrefix: boolean;
}

interface GovernancePayload {
  planApprovals: Record<string, PlanApprovalRequest>;
  modelPolicy: ModelPolicyState;
}

const DEFAULT_PAYLOAD: GovernancePayload = {
  planApprovals: {},
  modelPolicy: {
    allowedModels: [],
    blockedModels: [],
    requireProviderPrefix: false,
  },
};

export class GovernanceStore {
  constructor(private rootDir?: string) {}

  getPlan(agent: string): PlanApprovalRequest | undefined {
    return this.read().planApprovals[agent];
  }

  requestPlan(agent: string): PlanApprovalRequest {
    const payload = this.read();
    const plan: PlanApprovalRequest = {
      agent,
      status: "pending",
      requestedAt: new Date().toISOString(),
    };
    payload.planApprovals[agent] = plan;
    this.write(payload);
    return plan;
  }

  resolvePlan(agent: string, status: "approved" | "rejected", feedback?: string): PlanApprovalRequest {
    const payload = this.read();
    const existing = payload.planApprovals[agent] ?? {
      agent,
      status: "pending" as const,
      requestedAt: new Date().toISOString(),
    };
    existing.status = status;
    existing.feedback = feedback;
    existing.resolvedAt = new Date().toISOString();
    payload.planApprovals[agent] = existing;
    this.write(payload);
    return existing;
  }

  getModelPolicy(): ModelPolicyState {
    return this.read().modelPolicy;
  }

  setModelPolicy(policy: Partial<ModelPolicyState>): ModelPolicyState {
    const payload = this.read();
    payload.modelPolicy = {
      ...payload.modelPolicy,
      ...policy,
      allowedModels: policy.allowedModels ?? payload.modelPolicy.allowedModels,
      blockedModels: policy.blockedModels ?? payload.modelPolicy.blockedModels,
    };
    this.write(payload);
    return payload.modelPolicy;
  }

  checkModel(model?: string): { ok: boolean; reason: string } {
    const policy = this.getModelPolicy();
    if (!model) return { ok: true, reason: "no model override provided" };
    if (policy.requireProviderPrefix && !model.includes("/")) {
      return { ok: false, reason: "model must include provider/model format" };
    }
    if (policy.blockedModels.includes(model)) {
      return { ok: false, reason: `model \"${model}\" is blocked` };
    }
    if (policy.allowedModels.length > 0 && !policy.allowedModels.includes(model)) {
      return { ok: false, reason: `model \"${model}\" is not in allowed list` };
    }
    return { ok: true, reason: "model allowed" };
  }

  private read(): GovernancePayload {
    const paths = ensureRuntimeDir(this.rootDir);
    if (!existsSync(paths.governanceFile)) {
      return structuredClone(DEFAULT_PAYLOAD);
    }
    try {
      return JSON.parse(readFileSync(paths.governanceFile, "utf-8")) as GovernancePayload;
    } catch {
      return structuredClone(DEFAULT_PAYLOAD);
    }
  }

  private write(payload: GovernancePayload): void {
    const paths = ensureRuntimeDir(this.rootDir);
    writeFileSync(paths.governanceFile, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  }
}
