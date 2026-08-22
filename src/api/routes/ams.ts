import { FastifyInstance } from 'fastify';
import { PrinterService } from '../../domain/PrinterService.js';
import { AMSTray } from '../../domain/PrinterState.js';

export async function amsRoutes(
  fastify: FastifyInstance,
  options: { printerService: PrinterService }
): Promise<void> {
  const { printerService } = options;

  fastify.get('/api/ams', async () => {
    const state = printerService.stateStore.getState();
    const amsList = state.ams || [];

    const normalizedUnits = amsList.map((unit) => {
      const trays = (unit.trays || []).map((fil: AMSTray, idx: number) => ({
        id: idx,
        filamentType: fil.type || 'UNKNOWN',
        color: fil.color ? (fil.color.startsWith('#') ? fil.color : `#${fil.color}`) : '#FFFFFF',
        remaining: fil.remain ?? null,
      }));

      return {
        id: unit.id,
        trays,
      };
    });

    return {
      units: normalizedUnits,
      activeTrayId: state.amsActiveTrayId ?? null,
    };
  });
}
