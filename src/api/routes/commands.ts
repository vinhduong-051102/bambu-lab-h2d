import { handler, json } from '../http';

// GET /api/commands - Audit Log list
export const getCommands = handler(({ printerService }) => {
  const log = printerService.commandService.getAuditLog();
  return json({
    count: log.getEntries().length,
    commands: log.getEntries(),
  });
});

// GET /api/commands/:id - Get specific command entry by ID
export const getCommandById = handler<{ id: string }>(({ printerService, params }) => {
  const entry = printerService.commandService.getAuditLog().getEntryById(params.id);

  if (!entry) {
    return json(
      { error: 'Not Found', message: `Command audit entry with id '${params.id}' not found` },
      404
    );
  }

  return json(entry);
});
