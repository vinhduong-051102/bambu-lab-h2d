import type { PrinterService } from '../../domain/PrinterService';
import { env } from '../../config/env';
import { discoverTemperatureFields } from '../../utils/temperatureDiscovery';
import { handler, json, type HandlerArgs } from '../http';

const getService = ({ printerService, printerManager }: HandlerArgs<any>, serial?: string): PrinterService | undefined => {
  if (printerManager) {
    return printerManager.getPrinter(serial);
  }
  return printerService;
};

const noPrinter = (status: number) =>
  json({ error: 'Service Unavailable', message: 'No printer registered' }, status);

const buildDiagnostics = (service: PrinterService) => {
  const state = service.stateStore.getState();
  const rawPayload = service.stateStore.getRawPayload();

  const tempCandidates = rawPayload?.print
    ? discoverTemperatureFields(rawPayload.print, 'print').map((candidate) => {
        let semantic = 'unknown';
        if (candidate.path.includes('extruder')) semantic = 'extruder';
        else if (candidate.path.includes('nozzle')) semantic = 'nozzle';
        else if (candidate.path.includes('bed')) semantic = 'bed';
        else if (candidate.path.includes('ctc') || candidate.path.includes('chamber')) semantic = 'chamber';
        else if (candidate.path.includes('ams')) semantic = 'ams';

        return {
          path: candidate.path,
          value: candidate.value,
          confidence: candidate.path.includes('extruder') || candidate.path.includes('bed') ? 'CONFIRMED' : 'POSSIBLE',
          semantic,
        };
      })
    : [];

  return {
    nozzleCount: state.temperatures.nozzles.length,
    extruderCount: state.extruders.length,
    activeNozzleId: state.temperatures.nozzle.activeNozzleId ?? null,
    machineNozzleTemperature: state.temperatures.nozzle,
    nozzles: state.temperatures.nozzles,
    extruders: state.extruders,
    temperatureCandidates: tempCandidates,
    rawPayload,
    historyDiffs: service.stateStore.getPayloadHistory(),
  };
};

// 1. GET /api/printer - Standard State Endpoint
export const getPrinter = handler((args) => {
  const service = getService(args);
  if (!service) return noPrinter(503);
  return json({
    ...service.stateStore.getState(),
    realPrinterMode: env.BAMBU_REAL_PRINTER,
  });
});

// 2. GET /api/printer/diagnostics - Diagnostic Endpoint
export const getDiagnostics = handler((args) => {
  const service = getService(args);
  if (!service) return noPrinter(503);
  return json(buildDiagnostics(service));
});

// 3. GET /api/printer/:serial/diagnostics - Serial Diagnostic Endpoint
export const getDiagnosticsBySerial = handler<{ serial: string }>((args) => {
  const service = getService(args, args.params.serial);
  if (!service) return noPrinter(404);
  return json(buildDiagnostics(service));
});

// 4. GET /api/printer/info - System Info
export const getPrinterInfo = handler((args) => {
  const service = getService(args);
  if (!service) return noPrinter(503);
  const state = service.stateStore.getState();

  return json({
    model: state.model || 'Bambu Lab H2D',
    serial: state.serial,
    firmware: state.firmware || 'Unknown',
    online: state.online,
    realPrinterMode: env.BAMBU_REAL_PRINTER,
    updatedAt: state.updatedAt,
  });
});

// 5. GET /api/printer/raw - Get Raw MQTT JSON Payload
export const getPrinterRaw = handler((args) => {
  const service = getService(args);
  if (!service) return noPrinter(503);
  const rawPayload = service.stateStore.getRawPayload();
  return json({
    serial: service.serial,
    hasRawPayload: rawPayload !== null,
    rawPayload,
  });
});

// 6. GET /api/printer/errors - HMS & System Error Codes
export const getPrinterErrors = handler((args) => {
  const service = getService(args);
  if (!service) return noPrinter(503);
  const state = service.stateStore.getState();

  return json({
    serial: state.serial,
    online: state.online,
    hmsErrors: state.hmsErrors || [],
    errorState: state.state === 'FAILED',
  });
});

// 7. GET /api/printers - Multi-Printer List
export const listPrinters = handler(({ printerService, printerManager }) => {
  const services = printerManager ? printerManager.getAllPrinters() : [printerService];
  return json({
    count: services.length,
    printers: services.map((p) => {
      const state = p.stateStore.getState();
      return {
        serial: p.serial,
        model: state.model || 'Bambu Lab H2D',
        online: state.online,
        state: state.state,
      };
    }),
  });
});

// 8. GET /api/printers/:serial - Get specific printer by Serial
export const getPrinterBySerial = handler<{ serial: string }>((args) => {
  const { serial } = args.params;
  const service = getService(args, serial);
  if (!service) {
    return json({ error: 'Not Found', message: `Printer with serial '${serial}' not found` }, 404);
  }
  return json(service.stateStore.getState());
});
