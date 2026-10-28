import { promises as fs } from 'fs';
import path from 'path';
import { z } from 'zod';
import { env } from '../../config/env';
import { CadWorkerError } from '../../domain/cad/cadJobs';
import { handler, json, readJsonBody } from '../http';

/**
 * STEP/IGES to STL in the CAD container (cad/convert.py, docs/cad.md): the mesh worker has no CAD kernel, the CAD
 * one has OpenCascade. Each solid of the file becomes its own STL in the job's out/ folder.
 */

const MAX_CONVERT_BYTES = 100 * 1024 * 1024;
const CAD_SUFFIXES = ['.step', '.stp', '.iges', '.igs'];
// The worker gives a conversion 300 s
const CONVERT_TIMEOUT_MS = 320_000;
const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{5,63}$/;
// What convert.py names its STLs ("01-box.stl"), and its report
const CONVERTED_FILE_RE = /^(\d{2,}-[A-Za-z0-9_-]+\.stl|convert\.json)$/;

export interface ConvertedSolid {
  name: string;
  /** In the job's out/ folder */
  file: string;
  volume_mm3: number;
  bbox: { min: number[]; max: number[]; size: number[] };
  faces: number;
  mesh: { triangles: number; watertight: boolean; open_edges: number; non_manifold_edges: number };
}

export interface ConvertResult {
  ok: true;
  job_id: string;
  source: string;
  /** The file's own length unit ("millimetre", "inch"; a list when it has several); the STLs are always in mm */
  units: string | string[] | null;
  tolerance_mm: number;
  angular_tolerance_deg: number;
  solids: ConvertedSolid[];
  warnings: string[];
  seconds: number;
}

export interface ConvertRequest {
  /** A file already in the jobs folder, relative to it */
  file?: string;
  data_base64?: string;
  filename?: string;
  job_id?: string;
  tolerance_mm?: number;
  angular_tolerance_deg?: number;
}

/** The CAD worker's POST /convert (cad/worker.py) */
export interface CadConverterApi {
  convert(request: ConvertRequest): Promise<ConvertResult>;
}

class CadConverterClient implements CadConverterApi {
  constructor(private readonly baseUrl: string) {}

  async convert(request: ConvertRequest): Promise<ConvertResult> {
    let res: Response;
    try {
      res = await fetch(new URL('/convert', this.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'không trả lời kịp' : 'không kết nối được';
      throw new CadWorkerError(502, 'CAD_WORKER_UNREACHABLE', `Container CAD ${reason} (${this.baseUrl}).`);
    }
    const data = (await res.json().catch(() => null)) as (ConvertResult & { error?: string; message?: string }) | null;
    if (!res.ok || !data) {
      throw new CadWorkerError(res.status, data?.error ?? 'CAD_WORKER_ERROR', data?.message ?? `Container CAD trả lỗi HTTP ${res.status}.`);
    }
    return data;
  }
}

let converterOverride: CadConverterApi | null = null;
let jobsDirOverride: string | null = null;

/** Tests replace the CAD container's converter with a fake; null restores CAD_WORKER_URL */
export function setCadConverter(converter: CadConverterApi | null): void {
  converterOverride = converter;
}

/** Tests keep the converted files in a temporary folder; null restores CAD_JOBS_DIR */
export function setConvertJobsDir(dir: string | null): void {
  jobsDirOverride = dir;
}

const converter = (): CadConverterApi | null => converterOverride ?? (env.CAD_WORKER_URL ? new CadConverterClient(env.CAD_WORKER_URL) : null);
const jobsDir = () => jobsDirOverride ?? path.resolve(env.CAD_JOBS_DIR);

const convertSchema = z
  .object({
    file: z.string().trim().min(1).optional(),
    data_base64: z.string().min(1).optional(),
    filename: z.string().trim().min(1).max(200).optional(),
    job_id: z.string().regex(JOB_ID_RE, 'job_id không hợp lệ.').optional(),
    tolerance_mm: z.coerce.number().min(0.0005).max(1).optional(),
    angular_tolerance_deg: z.coerce.number().min(0.05).max(30).optional(),
  })
  .refine((body) => body.file || (body.data_base64 && body.filename), 'Cần "file" hoặc "data_base64" cùng "filename" (hoặc upload multipart "file").')
  .refine(
    (body) => !body.filename || CAD_SUFFIXES.includes(path.extname(body.filename).toLowerCase()),
    'Chỉ nhận file .step, .stp, .iges, .igs.'
  );

const fileUrl = (jobId: string, name: string) => `/api/cad/convert/${jobId}/${encodeURIComponent(name)}`;

/**
 * POST /api/cad/convert - STEP/IGES to one STL per solid, in mm. JSON {file} (a path in the jobs folder) or
 * {data_base64, filename, job_id?}, or multipart with the upload as "file"; both with tolerance_mm (default 0.01)
 * and angular_tolerance_deg (default 0.5). 200 with the solids (name, OpenCascade's volume, bounding box, faces, the
 * STL's url) and the file's unit; 422 CONVERT_FAILED for a file that can't be read, with no STL written.
 */
export const convertCadFile = handler(async ({ request }) => {
  const c = converter();
  if (!c) {
    return json({ success: false, error: 'CAD_DISABLED', message: 'Chưa cấu hình CAD_WORKER_URL (docker-compose.cad.yml, docs/cad.md).' }, 501);
  }
  // base64 is 4/3 of the file
  if (Number(request.headers.get('content-length') ?? 0) > (MAX_CONVERT_BYTES * 4) / 3 + 64 * 1024) {
    return json({ success: false, error: 'FILE_TOO_LARGE', message: `File vượt quá ${MAX_CONVERT_BYTES / 1024 / 1024} MB.` }, 413);
  }

  let fields: Record<string, unknown>;
  if ((request.headers.get('content-type') ?? '').includes('multipart/form-data')) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json({ success: false, error: 'INVALID_PAYLOAD', message: 'Expected multipart/form-data.' }, 400);
    }
    fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string'));
    const upload = form.get('file');
    if (upload instanceof File) {
      if (upload.size > MAX_CONVERT_BYTES) {
        return json({ success: false, error: 'FILE_TOO_LARGE', message: `File vượt quá ${MAX_CONVERT_BYTES / 1024 / 1024} MB.` }, 413);
      }
      fields = { ...fields, file: undefined, filename: upload.name, data_base64: Buffer.from(await upload.arrayBuffer()).toString('base64') };
    }
  } else {
    fields = ((await readJsonBody(request)) ?? {}) as Record<string, unknown>;
  }
  const body = convertSchema.safeParse(fields);
  if (!body.success) {
    const issue = body.error.issues[0];
    return json({ success: false, error: 'INVALID_PAYLOAD', message: `${issue.path.join('.') || '(gốc)'}: ${issue.message}` }, 400);
  }

  let result: ConvertResult;
  try {
    result = await c.convert(body.data);
  } catch (err) {
    if (!(err instanceof CadWorkerError)) throw err;
    return json({ success: false, error: err.code, message: err.message }, err.status >= 500 || err.status < 400 ? 502 : err.status);
  }
  return json({
    success: true,
    ...result,
    solids: result.solids.map((solid) => ({ ...solid, url: fileUrl(result.job_id, solid.file) })),
    report_url: fileUrl(result.job_id, 'convert.json'),
  });
});

// GET /api/cad/convert/:id/:name?download=1 - One STL of a conversion ("01-box.stl"), or its convert.json
export const getConvertedFile = handler<{ id: string; name: string }>(async ({ request, params }) => {
  const notFound = () => json({ success: false, error: 'FILE_NOT_FOUND', message: 'Không có file này.' }, 404);
  if (!JOB_ID_RE.test(params.id) || !CONVERTED_FILE_RE.test(params.name)) return notFound();
  const data = await fs.readFile(path.join(jobsDir(), params.id, 'out', params.name)).catch(() => null);
  if (!data) return notFound();
  const headers: Record<string, string> = {
    'Content-Type': params.name.endsWith('.stl') ? 'model/stl' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  };
  if (new URL(request.url).searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="${params.name}"`;
  return new Response(new Uint8Array(data), { headers });
});
