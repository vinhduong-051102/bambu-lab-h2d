export interface CommandResult {
  success: boolean;
  commandId: string;
  message?: string;
  error?: string;
}

export interface PrinterCommand<TPayload = unknown> {
  id: string;
  capabilityId: string;
  execute(payload: TPayload): Promise<CommandResult>;
}
