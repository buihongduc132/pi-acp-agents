import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureRuntimeDir } from "./runtime-paths.js";

interface SessionNameRecord {
  sessionName: string;
  sessionId: string;
}

interface SessionNameRegistryPayload {
  mappings: SessionNameRecord[];
}

const DEFAULT_PAYLOAD: SessionNameRegistryPayload = { mappings: [] };

function normalizeSessionName(sessionName: string): string {
  const normalized = sessionName.trim();
  if (normalized === "") {
    throw new Error("session_name is required");
  }
  return normalized;
}

export class SessionNameStore {
  constructor(
    private rootDir?: string,
    private options?: { treatAsRuntimeDir?: boolean },
  ) {}

  getSessionId(sessionName: string): string | undefined {
    const normalizedName = normalizeSessionName(sessionName);
    return this.read().mappings.find((entry) => entry.sessionName === normalizedName)?.sessionId;
  }

  getName(sessionId: string): string | undefined {
    return this.read().mappings.find((entry) => entry.sessionId === sessionId)?.sessionName;
  }

  register(sessionName: string, sessionId: string): SessionNameRecord {
    const normalizedName = normalizeSessionName(sessionName);
    const payload = this.read();
    const existingByName = payload.mappings.find((entry) => entry.sessionName === normalizedName);
    if (existingByName && existingByName.sessionId !== sessionId) {
      throw new Error(`Session name "${normalizedName}" is already assigned to session "${existingByName.sessionId}".`);
    }
    const existingBySession = payload.mappings.find((entry) => entry.sessionId === sessionId);
    if (existingBySession && existingBySession.sessionName !== normalizedName) {
      throw new Error(`Session "${sessionId}" is already assigned friendly name "${existingBySession.sessionName}".`);
    }
    const record = existingByName ?? existingBySession ?? { sessionName: normalizedName, sessionId };
    if (!existingByName && !existingBySession) {
      payload.mappings.push(record);
      this.write(payload);
    }
    return record;
  }

  private get filePath(): string {
    if (this.options?.treatAsRuntimeDir && this.rootDir) {
      return `${this.rootDir}/session-name-registry.json`;
    }
    return ensureRuntimeDir(this.rootDir).sessionNameRegistryFile;
  }

  private read(): SessionNameRegistryPayload {
    if (!existsSync(this.filePath)) return structuredClone(DEFAULT_PAYLOAD);
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as SessionNameRegistryPayload;
      return { mappings: Array.isArray(parsed.mappings) ? parsed.mappings.filter((entry) => entry?.sessionName && entry?.sessionId) : [] };
    } catch {
      return structuredClone(DEFAULT_PAYLOAD);
    }
  }

  private write(payload: SessionNameRegistryPayload): void {
    writeFileSync(this.filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }
}
