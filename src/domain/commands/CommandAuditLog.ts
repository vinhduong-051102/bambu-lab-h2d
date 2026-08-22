export interface CommandAuditEntry {
  id: string;
  command: string;
  capabilityId: string;
  payload?: unknown;
  createdAt: string;
  completedAt?: string;
  success: boolean;
  message?: string;
  error?: string;
}

export class CommandAuditLog {
  private entries: CommandAuditEntry[] = [];
  private maxEntries = 200;

  public addEntry(entry: CommandAuditEntry): void {
    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.pop();
    }
  }

  public updateEntry(
    id: string,
    updates: Partial<Omit<CommandAuditEntry, 'id' | 'command' | 'capabilityId' | 'createdAt'>>
  ): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) {
      Object.assign(entry, updates);
    }
  }

  public getEntries(): CommandAuditEntry[] {
    return [...this.entries];
  }

  public getEntryById(id: string): CommandAuditEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }
}
