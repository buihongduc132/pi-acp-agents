/**
 * Session-scoped store factory — creates per-session instances of all
 * session-scoped stores, cached by session ID.
 *
 * Global stores (SessionNameStore, AcpEventLog) stay singletons and are
 * NOT part of this factory.
 */
import { AcpTaskStore } from "./task-store.js";
import { MailboxManager } from "./mailbox-manager.js";
import { GovernanceStore } from "./governance-store.js";
import { WorkerStore } from "./worker-store.js";
import { SessionArchiveStore } from "./session-archive-store.js";
import { migrateLegacyLayout } from "./legacy-migration.js";
import { ensureRuntimeDir } from "./runtime-paths.js";

export interface SessionStores {
  taskStore: AcpTaskStore;
  mailboxManager: MailboxManager;
  governanceStore: GovernanceStore;
  workerStore: WorkerStore;
  sessionArchiveStore: SessionArchiveStore;
}

export class SessionStoreFactory {
  private cache = new Map<string, SessionStores>();
  private migrated = false;

  constructor(private rootDir?: string) {}

  /**
   * Get all session-scoped stores for a given session ID.
   * Lazily creates them on first access; cached thereafter.
   */
  get(sessionId: string): SessionStores {
    const existing = this.cache.get(sessionId);
    if (existing) return existing;

    // Run legacy migration once before creating any stores
    if (!this.migrated) {
      const paths = ensureRuntimeDir(this.rootDir);
      migrateLegacyLayout(paths.rootDir);
      this.migrated = true;
    }

    const stores: SessionStores = {
      taskStore: new AcpTaskStore(this.rootDir, sessionId),
      mailboxManager: new MailboxManager(this.rootDir, sessionId),
      governanceStore: new GovernanceStore(this.rootDir, sessionId),
      workerStore: new WorkerStore(this.rootDir, sessionId),
      sessionArchiveStore: new SessionArchiveStore(this.rootDir, sessionId),
    };
    this.cache.set(sessionId, stores);
    return stores;
  }

  /** Clear cached stores (useful for testing). */
  clear(): void {
    this.cache.clear();
    this.migrated = false;
  }
}
