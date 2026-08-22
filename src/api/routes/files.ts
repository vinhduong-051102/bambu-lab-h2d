import { FastifyInstance } from 'fastify';

export async function fileRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/files
  fastify.get('/api/files', async (request, reply) => {
    return reply.status(501).send({
      status: 'UNKNOWN',
      capability: 'file.list',
      message: 'SD Card File listing requires FTPS port 990 connection. File list is not exposed over LAN MQTT protocol.',
      files: [],
    });
  });

  // POST /api/files/upload
  fastify.post('/api/files/upload', async (request, reply) => {
    return reply.status(501).send({
      status: 'UNSUPPORTED',
      capability: 'file.upload',
      message: 'Direct Gcode/3MF file uploads require explicit FTPS (Port 990 TLS) upload sessions. Uploads over MQTT LAN protocol are unsupported.',
    });
  });

  // DELETE /api/files/:id
  fastify.delete('/api/files/:id', async (request, reply) => {
    return reply.status(501).send({
      status: 'UNSUPPORTED',
      capability: 'file.delete',
      message: 'File deletion requires FTPS session.',
    });
  });

  // POST /api/files/:id/print
  fastify.post('/api/files/:id/print', async (request, reply) => {
    return reply.status(501).send({
      status: 'UNKNOWN',
      capability: 'print.start',
      message: 'Print start from SD Card file requires verified project 3MF metadata parameters.',
    });
  });
}
