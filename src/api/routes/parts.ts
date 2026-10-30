import path from 'path';
import { env } from '../../config/env';
import { PrintJournal, type PrintRecord } from '../../domain/prints/PrintJournal';
import type { StudioRequest } from '../../domain/studio/aiOptimize';
import { describeFeature, describeParts, MeshPartsWorker, ModelParts, ModelPartsStore, objectsOf, type ModelAnalysis, type PrintWithParts } from '../../domain/studio/modelParts';
import { ClaudeCodeVision } from '../../domain/timelapse/TimelapseReviewer';
import { getTask, startTask } from '../../domain/backgroundTasks';
import { handler, json } from '../http';

/**
 * "Thành phần của mẫu" (docs/studio.md): the measured parts of the models on a print, the renders Claude names
 * them from, and analysing the earlier prints so "AI tối ưu" can compare parts with them.
 */

// While "AI tối ưu" waits: measuring takes seconds, Claude naming the parts up to a minute or so
const NAME_WITHIN_MS = 90_000;
const PARTS_BUDGET_MS = 120_000;
const PAST_PRINTS = 200;
// Measuring a print's objects goes on when the page closes; what fails at once is answered at once
const ANALYZE_WAIT_MS = 1500;
const analyzeTask = (printId: string) => `print-parts:${printId}`;

let partsOverride: ModelParts | null = null;
let journalOverride: PrintJournal | null = null;
let shared: ModelParts | null = null;

/** Tests swap in a fake worker and namer, and a temporary print history; null restores the real ones */
export function setModelParts(parts: ModelParts | null, journal: PrintJournal | null = null): void {
  partsOverride = parts;
  journalOverride = journal;
}

/** One for the gateway: it remembers the analyses being made, so an object is never measured twice at once */
export function modelParts(): ModelParts {
  if (partsOverride) return partsOverride;
  shared ??= new ModelParts(
    path.resolve(env.STUDIO_IMPORT_DIR ?? './data/studio/imports'),
    new ModelPartsStore(path.resolve(env.MODEL_ANALYSIS_DIR)),
    env.MESH_WORKER_URL && env.STUDIO_IMPORT_DIR ? new MeshPartsWorker(env.MESH_WORKER_URL) : null,
    new ClaudeCodeVision(env.PARTS_AI_MODEL, undefined, undefined, 'parts')
  );
  return shared;
}

const journal = () => journalOverride ?? new PrintJournal(path.resolve(env.PRINT_HISTORY_DIR));

/** Earlier prints the user reported on (or whose timelapse review they chose), with their parts as already measured */
export async function printsWithParts(): Promise<PrintWithParts[]> {
  const parts = modelParts();
  const prints = (await journal().list(PAST_PRINTS)).filter((p) => p.setup && p.status !== 'printing' && (p.feedback || p.video_review));
  const withParts = await Promise.all(
    prints.map(async (print) => ({
      print,
      analyses: (await Promise.all(objectsOf(print.setup!).map((o) => parts.cached(o)))).filter((a): a is ModelAnalysis => !!a?.matched),
    }))
  );
  return withParts.filter((p) => p.analyses.length > 0);
}

/**
 * The prompt's section on the plate's parts (empty when the mesh worker isn't set up or nothing could be measured):
 * the plate's objects measured now (or as kept), compared with the earlier prints' parts. Never slower than
 * PARTS_BUDGET_MS, so "AI tối ưu" answers within Studio's wait.
 */
export async function partsSection(request: StudioRequest): Promise<string[]> {
  const parts = modelParts();
  if (!parts.enabled) return [];
  const work = (async () => {
    const current = await Promise.all(objectsOf(request).map((o) => parts.analyze(o, { nameWithinMs: NAME_WITHIN_MS }).catch(() => null)));
    return describeParts(current.filter((a): a is ModelAnalysis => !!a), await printsWithParts());
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string[]>((resolve) => (timer = setTimeout(resolve, PARTS_BUDGET_MS, [])));
  try {
    return await Promise.race([work.catch(() => []), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Starts measuring a print's objects in the background (when Studio sends a print), so later prompts can use them */
export function analyzeInBackground(objects: StudioRequest['objects']): void {
  const parts = modelParts();
  if (!parts.enabled) return;
  for (const object of objectsOf({ objects })) parts.analyze(object).catch(() => {});
}

interface ObjectParts {
  name: string;
  /** missing: the mesh isn't in Studio's import folder; pending: not measured yet */
  status: 'missing' | 'pending' | 'done';
  /** Each feature also says itself in words (`text`), as the prompt does */
  analysis: (Omit<ModelAnalysis, 'features'> & { features: (ModelAnalysis['features'][number] & { text: string })[] }) | null;
}

async function partsOfPrint(print: PrintRecord, measure: boolean): Promise<ObjectParts[]> {
  const parts = modelParts();
  return Promise.all(
    objectsOf(print.setup!).map(async (object) => {
      if (!(await parts.locate(object))) return { name: object.name, status: 'missing' as const, analysis: null };
      const analysis = measure ? await parts.analyze(object, { retryNaming: true }) : await parts.cached(object);
      if (!analysis) return { name: object.name, status: 'pending' as const, analysis: null };
      return { name: object.name, status: 'done' as const, analysis: { ...analysis, features: analysis.features.map((f) => ({ ...f, text: describeFeature(f) })) } };
    })
  );
}

const printNotFound = () => json({ success: false, error: 'PRINT_NOT_FOUND', message: 'Không tìm thấy bản in này.' }, 404);
const disabled = () =>
  json({ success: false, error: 'PARTS_DISABLED', message: 'Cần MESH_WORKER_URL (container mesh3d) và STUDIO_IMPORT_DIR để đo thành phần.' }, 501);

// GET /api/prints/:id/parts - The parts of the print's objects, as measured so far
export const getPrintParts = handler<{ id: string }>(async ({ params }) => {
  const print = await journal().get(params.id);
  if (!print) return printNotFound();
  if (!print.setup) return json({ success: true, enabled: modelParts().enabled, objects: [] });
  // `task`: the analysis running now (started before the page was opened again, say) or how the last one ended
  return json({ success: true, enabled: modelParts().enabled, objects: await partsOfPrint(print, false), task: getTask(analyzeTask(print.id)) });
});

// POST /api/prints/:id/parts - Measures the print's objects and has Claude name their parts, again when it failed (takes up to a minute or two)
export const analyzePrintParts = handler<{ id: string }>(async ({ params }) => {
  if (!modelParts().enabled) return disabled();
  const print = await journal().get(params.id);
  if (!print) return printNotFound();
  if (!print.setup) return json({ success: false, error: 'NO_SETUP', message: 'Bản in không gửi từ Studio nên không biết mẫu nào.' }, 422);
  const { outcome, state } = await startTask(analyzeTask(print.id), () => partsOfPrint(print, true), {
    info: { kind: 'print-parts', label: print.job_name, page: 'prints' },
    waitMs: ANALYZE_WAIT_MS,
    // The objects Claude could not name, or whose mesh is gone from Studio's imports
    explain: (objects) =>
      objects.flatMap((o) =>
        o.status === 'missing'
          ? [`${o.name}: không còn file mẫu trong thư mục imports của Studio`]
          : o.analysis?.naming_error
            ? [`${o.name}: ${o.analysis.naming_error}`]
            : []
      ),
  });
  if (outcome && 'value' in outcome) return json({ success: true, enabled: true, objects: outcome.value });
  if (outcome) {
    const err = outcome.error;
    return json({ success: false, error: 'PARTS_FAILED', message: err instanceof Error ? err.message : String(err) }, 502);
  }
  // Still measuring (or it already was): GET says when it is done
  return json({ success: true, enabled: true, running: true, task: state, objects: await partsOfPrint(print, false) }, 202);
});

// ---------- Earlier prints, all at once ----------

const BACKFILL_TASK = 'parts-backfill';

/** How far measuring the earlier prints has got, in the shape the button reads */
function backfillState() {
  const task = getTask(BACKFILL_TASK);
  return {
    running: task?.running ?? false,
    total: task?.progress?.total ?? 0,
    done: task?.progress?.done ?? 0,
    failed: task?.details ?? [],
    started_at: task?.started_at ?? null,
    finished_at: task?.finished_at ?? null,
  };
}

// GET /api/studio/parts/backfill - How far measuring the earlier prints has got
export const getPartsBackfill = handler(() => json({ success: true, enabled: modelParts().enabled, ...backfillState() }));

// POST /api/studio/parts/backfill - Measures every object of every print sent from Studio, one after another
export const startPartsBackfill = handler(async () => {
  if (!modelParts().enabled) return disabled();
  if (getTask(BACKFILL_TASK)?.running) return json({ success: true, ...backfillState() }, 202);
  const parts = modelParts();
  const prints = (await journal().list(PAST_PRINTS)).filter((p) => p.setup);
  const objects = [...new Map(prints.flatMap((p) => objectsOf(p.setup!)).map((o) => [JSON.stringify(o), o])).values()];
  await startTask(
    BACKFILL_TASK,
    async (progress) => {
      // Objects that did not match a mesh are listed; ones that failed (or Claude could not name) make it an error
      const notes: string[] = [];
      let failures = 0;
      progress(0, objects.length);
      for (const [i, object] of objects.entries()) {
        try {
          const analysis = await parts.analyze(object);
          if (analysis && !analysis.matched) notes.push(`${object.name}: ${analysis.reason ?? 'không khớp'}`);
          if (analysis?.naming_error) {
            notes.push(`${object.name}: ${analysis.naming_error}`);
            failures++;
          }
        } catch (err) {
          notes.push(`${object.name}: ${err instanceof Error ? err.message : String(err)}`);
          failures++;
        }
        progress(i + 1, objects.length, notes);
      }
      return { notes, failures };
    },
    {
      info: { kind: 'parts-backfill', label: `${objects.length} vật thể của các bản in cũ`, page: 'prints' },
      failed: ({ failures }) => (failures ? `${failures}/${objects.length} vật thể chưa đo hoặc chưa đặt tên được` : null),
      explain: ({ notes }) => notes,
    }
  );
  return json({ success: true, ...backfillState() }, 202);
});

// GET /api/studio/parts/:key/:image - A render of an analysis (views.png, parts.png)
export const getPartsImage = handler<{ key: string; image: string }>(async ({ params }) => {
  const image = await modelParts().store.image(params.key, params.image);
  if (!image) return json({ success: false, error: 'NOT_FOUND', message: 'Không có ảnh này.' }, 404);
  return new Response(new Uint8Array(image), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400' } });
});
