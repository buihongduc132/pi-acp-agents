import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureRuntimeDir } from "./runtime-paths.js";

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  message: string;
  kind: "dm" | "steer" | "broadcast";
  createdAt: string;
  readAt?: string;
}

interface MailboxPayload {
  nextId: number;
  messages: MailMessage[];
}

const DEFAULT_PAYLOAD: MailboxPayload = {
  nextId: 1,
  messages: [],
};

export class MailboxManager {
  constructor(private rootDir?: string) {}

  send(input: { from: string; to: string; message: string; kind: MailMessage["kind"] }): MailMessage {
    const payload = this.read();
    const mail: MailMessage = {
      id: String(payload.nextId++),
      from: input.from,
      to: input.to,
      message: input.message,
      kind: input.kind,
      createdAt: new Date().toISOString(),
    };
    payload.messages.push(mail);
    this.write(payload);
    return mail;
  }

  listFor(recipient: string): MailMessage[] {
    return this.read().messages.filter((message) => message.to === recipient || message.to === "*");
  }

  markRead(messageId: string): MailMessage {
    const payload = this.read();
    const message = payload.messages.find((item) => item.id === messageId);
    if (!message) throw new Error(`Message \"${messageId}\" not found`);
    message.readAt = new Date().toISOString();
    this.write(payload);
    return message;
  }

  clearFor(recipient: string): number {
    const payload = this.read();
    const before = payload.messages.length;
    payload.messages = payload.messages.filter((message) => !(message.to === recipient || message.to === "*"));
    this.write(payload);
    return before - payload.messages.length;
  }

  private read(): MailboxPayload {
    const paths = ensureRuntimeDir(this.rootDir);
    if (!existsSync(paths.mailboxesFile)) {
      return structuredClone(DEFAULT_PAYLOAD);
    }
    try {
      return JSON.parse(readFileSync(paths.mailboxesFile, "utf-8")) as MailboxPayload;
    } catch {
      return structuredClone(DEFAULT_PAYLOAD);
    }
  }

  private write(payload: MailboxPayload): void {
    const paths = ensureRuntimeDir(this.rootDir);
    writeFileSync(paths.mailboxesFile, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  }
}
