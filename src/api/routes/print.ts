import { commandErrorResponse, handler, json } from '../http';

// GET /api/print/current - Current Print Job Status
export const getCurrentPrint = handler(({ printerService }) => {
  const state = printerService.stateStore.getState();
  return json({
    state: state.state,
    jobName: state.job?.name ?? null,
    progress: state.progress,
    currentLayer: state.job?.currentLayer ?? 0,
    totalLayers: state.job?.totalLayers ?? 0,
    remainingTimeMinutes: state.job?.remainingTimeMinutes ?? null,
    online: state.online,
  });
});

// POST /api/printer/actions/pause & POST /api/print/pause
export const pausePrint = handler(async ({ printerService }) => {
  try {
    const res = await printerService.commandService.pausePrint();
    return json({ success: true, action: 'pause', commandId: res.commandId, message: res.message });
  } catch (err) {
    return commandErrorResponse(err);
  }
});

// POST /api/printer/actions/resume & POST /api/print/resume
export const resumePrint = handler(async ({ printerService }) => {
  try {
    const res = await printerService.commandService.resumePrint();
    return json({ success: true, action: 'resume', commandId: res.commandId, message: res.message });
  } catch (err) {
    return commandErrorResponse(err);
  }
});

// POST /api/printer/actions/stop, /api/print/stop & /api/print/cancel
export const stopPrint = handler(async ({ printerService }) => {
  try {
    const res = await printerService.commandService.stopPrint();
    return json({ success: true, action: 'stop', commandId: res.commandId, message: res.message });
  } catch (err) {
    return commandErrorResponse(err);
  }
});
