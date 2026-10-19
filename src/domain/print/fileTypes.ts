/** Bare models Bambu Studio can import; the gateway always slices them (they carry no G-code or settings) */
export const MODEL_EXTENSIONS = ['.stl', '.obj', '.step', '.stp'] as const;

const MODEL_RE = /\.(stl|obj|step|stp)$/i;
const PROJECT_RE = /\.3mf$/i;

export function isModelFile(fileName: string): boolean {
  return MODEL_RE.test(fileName);
}

/** .3mf (project or sliced .gcode.3mf) or a bare model */
export function isSupportedUpload(fileName: string): boolean {
  return PROJECT_RE.test(fileName) || isModelFile(fileName);
}

/** "snoopy.stl" → ".stl", "snoopy.3mf" → ".3mf" */
export function uploadExtension(fileName: string): string {
  return (fileName.match(/\.(3mf|stl|obj|step|stp)$/i)?.[0] ?? '.3mf').toLowerCase();
}
