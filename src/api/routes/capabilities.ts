import { handler, json } from '../http';

export const getCapabilities = handler(({ printerService }) =>
  json({
    printer: 'Bambu Lab H2D',
    capabilities: printerService.capabilityRegistry.getAllCapabilities(),
  })
);
