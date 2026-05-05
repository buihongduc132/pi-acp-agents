/**
 * pi-acp-agents — Custom ACP adapter for user-defined commands
 */
import { AcpAgentAdapter, type AcpAdapterOptions } from "./base.js";

export class CustomAcpAdapter extends AcpAgentAdapter {
  get name(): string {
    return "custom";
  }

  constructor(opts: AcpAdapterOptions) {
    super(opts);
  }
}
