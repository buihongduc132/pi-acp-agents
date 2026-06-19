import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AcpArchivedSessionMetadata, AcpSessionHandle } from "../config/types.js";
import { ensureRuntimeDir } from "./runtime-paths.js";
import { createNoopLogger } from "../logger.js";

const log = createNoopLogger();

interface ArchivePayload {
  sessions: AcpArchivedSessionMetadataRecord[];
}

interface ParsedArchivePayload {
  sessions: AcpArchivedSessionMetadata[];
}

interface AcpArchivedSessionMetadataRecord {
  sessionId: string;
  sessionName?: string;
  agentName: string;
  cwd: string;
  createdAt: string;
  lastActivityAt: string;
  lastResponseAt?: string;
  completedAt?: string;
  disposed: boolean;
  autoClosed?: boolean;
  closeReason?: string;
  model?: string;
  mode?: string;
  loadStatus?: "loadable" | "unloadable" | "unknown";
  lastLoadAttemptAt?: string;
  lastLoadError?: string;
  loadAttemptCount?: number;
}

const DEFAULT_PAYLOAD: ArchivePayload = { sessions: [] };

export class SessionArchiveStore {
  constructor(
    private rootDir?: string,
    private sessionId?: string,
  ) {
    if (!sessionId || sessionId.trim() === "") {
      throw new Error("SessionArchiveStore requires a non-empty sessionId");
    }
  }

  get(sessionId: string): AcpArchivedSessionMetadata | undefined {
    return this.read().sessions.find((session) => session.sessionId === sessionId);
  }

  upsert(session: AcpSessionHandle | AcpArchivedSessionMetadata): AcpArchivedSessionMetadata {
    const payload = this.readRaw();
    const record = this.toRecord(session);
    const index = payload.sessions.findIndex((entry) => entry.sessionId === record.sessionId);
    if (index >= 0) {
      payload.sessions[index] = record;
    } else {
      payload.sessions.push(record);
    }
    this.writeRaw(payload);
    return this.fromRecord(record);
  }

  private get filePath(): string {
    const paths = ensureRuntimeDir(this.rootDir, this.sessionId);
    return paths.sessionArchiveFile;
  }

  private read(): ParsedArchivePayload {
    return {
      sessions: this.readRaw().sessions.map((session) => this.fromRecord(session)),
    };
  }

  private readRaw(): ArchivePayload {
    if (!existsSync(this.filePath)) {
      return structuredClone(DEFAULT_PAYLOAD);
    }
    try {
      return JSON.parse(readFileSync(this.filePath, "utf-8")) as ArchivePayload;
    } catch (e) {
      // File read failed — return default payload
      log.debug("session-archive-store read failed", e);
      return structuredClone(DEFAULT_PAYLOAD);
    }
  }

  private writeRaw(payload: ArchivePayload): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
    } catch (e) {
      // File read failed — return default payload
      // EACCES or other FS error — silently degrade.
      log.debug("session-archive-store write failed", e);
    }
  }

  private toRecord(session: AcpSessionHandle | AcpArchivedSessionMetadata): AcpArchivedSessionMetadataRecord {
    return {
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      agentName: session.agentName,
      cwd: session.cwd,
      createdAt: session.createdAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
      lastResponseAt: session.lastResponseAt?.toISOString(),
      completedAt: session.completedAt?.toISOString(),
      disposed: session.disposed,
      autoClosed: session.autoClosed,
      closeReason: session.closeReason,
      model: session.model,
      mode: session.mode,
      loadStatus: session.loadStatus,
      lastLoadAttemptAt: session.lastLoadAttemptAt,
      lastLoadError: session.lastLoadError,
      loadAttemptCount: session.loadAttemptCount,
    };
  }

  private fromRecord(record: AcpArchivedSessionMetadataRecord): AcpArchivedSessionMetadata {
    return {
      sessionId: record.sessionId,
      sessionName: record.sessionName,
      agentName: record.agentName,
      cwd: record.cwd,
      createdAt: new Date(record.createdAt),
      lastActivityAt: new Date(record.lastActivityAt),
      lastResponseAt: record.lastResponseAt ? new Date(record.lastResponseAt) : undefined,
      completedAt: record.completedAt ? new Date(record.completedAt) : undefined,
      disposed: record.disposed,
      autoClosed: record.autoClosed,
      closeReason: record.closeReason,
      model: record.model,
      mode: record.mode,
      loadStatus: record.loadStatus,
      lastLoadAttemptAt: record.lastLoadAttemptAt,
      lastLoadError: record.lastLoadError,
      loadAttemptCount: record.loadAttemptCount,
    };
  }
}
