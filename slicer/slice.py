#!/usr/bin/env python3
"""
Headless Bambu Studio slicing for the gateway (runs inside the slicer image).

Slices every plate of an unsliced project .3mf, or a bare STL/OBJ/STEP model, into a .gcode.3mf
for the target printer.

- A project already made for the target printer is sliced with its own embedded settings, so
  the user's process tweaks (supports, infill, ...) are kept.
- A project made for another printer (e.g. a MakerWorld model for the A1) is re-targeted: the
  machine, process and filament presets are swapped for the closest system presets of the
  target printer. The Studio CLI only accepts fully resolved presets, so each preset's
  `inherits` chain is flattened first.

Prints one JSON line on stdout describing the outcome; exit code 0 on success.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

STUDIO_DIR = os.environ.get('BAMBU_STUDIO_DIR', '/opt/bambu-studio')
PROFILES_DIR = os.path.join(STUDIO_DIR, 'resources', 'profiles', 'BBL')
SUPPORTED_NOZZLES = ('0.2', '0.4', '0.6', '0.8')
BED_TYPES = ('Textured PEI Plate', 'Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Supertack Plate')
# The H2D ships with the Textured PEI plate; the CLI would otherwise fall back to Cool Plate (35 °C bed for PLA)
DEFAULT_BED_TYPE = 'Textured PEI Plate'


def emit(outcome, code):
    print(json.dumps(outcome, ensure_ascii=False))
    sys.exit(code)


def fail(error, message, **extra):
    emit({'ok': False, 'error': error, 'message': message, **extra}, 1)


class PresetIndex:
    """System presets in one profile folder (machine / process / filament) by name."""

    def __init__(self, kind):
        self.kind = kind
        self.by_name = {}
        for dirpath, _, files in os.walk(os.path.join(PROFILES_DIR, kind)):
            for name in files:
                if not name.endswith('.json'):
                    continue
                try:
                    with open(os.path.join(dirpath, name), encoding='utf-8') as f:
                        data = json.load(f)
                except (OSError, ValueError):
                    continue
                if isinstance(data, dict) and 'name' in data:
                    self.by_name[data['name']] = data

    def instantiable(self):
        return [p for p in self.by_name.values() if str(p.get('instantiation', 'true')).lower() == 'true']

    def compatible_with(self, machine_name):
        return [p for p in self.instantiable() if machine_name in (p.get('compatible_printers') or [])]

    def flatten(self, name):
        path = []

        def resolve(n):
            if n in path:
                raise ValueError(f'inherits/include cycle at {n}')
            path.append(n)
            preset = self.by_name[n]
            merged = dict(resolve(preset['inherits'])) if preset.get('inherits') else {}
            # Since Studio 02.x the G-code (start/end/layer change/...) lives in "template" presets
            # pulled in by `include`; dropping them falls back to fdm_machine_common's generic G-code
            for included in as_list(preset.get('include')):
                merged.update({k: v for k, v in resolve(included).items() if k not in ('name', 'instantiation')})
            merged.update(preset)
            path.pop()
            return merged

        flat = resolve(name)
        flat.pop('inherits', None)
        flat.pop('include', None)
        flat['name'] = name
        return flat


def strip_vendor_suffix(preset_name):
    """'0.20mm Standard @BBL A1' -> '0.20mm Standard', 'Bambu PLA Basic @BBL A1 0.2 nozzle' -> 'Bambu PLA Basic'"""
    return re.sub(r'\s*@.*$', '', preset_name or '').strip()


def as_list(value):
    if isinstance(value, list):
        return value
    return [] if value is None else [value]


def pick_process(processes, machine_name, project_process, default_process=None):
    compatible = processes.compatible_with(machine_name)
    if not compatible:
        return None
    base = strip_vendor_suffix(project_process)
    layer = re.match(r'^(\d+\.\d+)mm', base)
    by_base = [p for p in compatible if strip_vendor_suffix(p['name']) == base]
    by_layer = [p for p in compatible if layer and p['name'].startswith(f'{layer.group(1)}mm')]
    layer_standard = [p for p in by_layer if 'Standard' in p['name']]
    # The machine's own default (0.20mm Standard for the H2D), not the alphabetically first "Standard"
    by_default = [p for p in compatible if p['name'] == default_process]
    standard = [p for p in compatible if 'Standard' in p['name']]
    for group in (by_base, layer_standard, by_layer, by_default, standard, compatible):
        if group:
            return sorted(group, key=lambda p: p['name'])[0]['name']
    return None


def pick_filament(filaments, machine_name, project_filament, filament_type):
    compatible = filaments.compatible_with(machine_name)
    base = strip_vendor_suffix(project_filament)
    ftype = (filament_type or 'PLA').strip()
    candidates = (
        [p for p in compatible if strip_vendor_suffix(p['name']) == base],
        [p for p in compatible if strip_vendor_suffix(p['name']) == f'Generic {ftype}'],
        [p for p in compatible if strip_vendor_suffix(p['name']) == f'Bambu {ftype} Basic'],
        [p for p in compatible if strip_vendor_suffix(p['name']) == 'Generic PLA'],
    )
    for group in candidates:
        if group:
            return sorted(group, key=lambda p: p['name'])[0]['name']
    return None


def read_project_settings(path):
    # A bare model (STL/OBJ/STEP) carries no settings: it is always sliced with the H2D system presets.
    # Studio centers it on the plate itself.
    if not path.lower().endswith('.3mf'):
        if not os.path.isfile(path):
            raise OSError(f'No such file: {path}')
        return {}
    with zipfile.ZipFile(path) as z:
        try:
            return json.loads(z.read('Metadata/project_settings.config'))
        except KeyError:
            return {}


def retarget(project, printer, nozzle, workdir):
    """Chooses + flattens target presets. Returns (cli args, profile summary)."""
    machines = PresetIndex('machine')
    machine_name = f'{printer} {nozzle} nozzle'
    if machine_name not in machines.by_name:
        fail('SLICER_PROFILE_NOT_FOUND', f'Không có profile máy "{machine_name}" trong Bambu Studio.')

    processes = PresetIndex('process')
    default_process = machines.flatten(machine_name).get('default_print_profile')
    process_name = pick_process(processes, machine_name, project.get('print_settings_id'), default_process)
    if not process_name:
        fail('SLICER_PROFILE_NOT_FOUND', f'Không tìm thấy profile process tương thích với {machine_name}.')

    filaments = PresetIndex('filament')
    project_filaments = as_list(project.get('filament_settings_id'))
    filament_types = as_list(project.get('filament_type'))
    count = max(len(project_filaments), len(filament_types), 1)
    filament_names = []
    for i in range(count):
        name = pick_filament(
            filaments,
            machine_name,
            project_filaments[i] if i < len(project_filaments) else None,
            filament_types[i] if i < len(filament_types) else None,
        )
        if not name:
            fail('SLICER_PROFILE_NOT_FOUND', f'Không tìm thấy profile filament #{i + 1} tương thích với {machine_name}.')
        filament_names.append(name)

    def write(kind_index, name, file_name):
        path = os.path.join(workdir, file_name)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(kind_index.flatten(name), f)
        return path

    machine_path = write(machines, machine_name, 'machine.json')
    process_path = write(processes, process_name, 'process.json')
    filament_paths = [write(filaments, name, f'filament_{i}.json') for i, name in enumerate(filament_names)]

    args = ['--load-settings', f'{machine_path};{process_path}', '--load-filaments', ';'.join(filament_paths)]
    profiles = {'machine': machine_name, 'process': process_name, 'filaments': filament_names}
    return args, profiles


def model_id_for(printer):
    # Machine models ("Bambu Lab H2D", type machine_model) live in the machine folder next to the presets
    preset = PresetIndex('machine').by_name.get(printer) or {}
    return preset.get('model_id')


def fill_printer_model_id(path, model_id):
    """The CLI leaves slice_info's printer_model_id empty; Studio's GUI export fills it in."""
    with zipfile.ZipFile(path) as src:
        info = src.read('Metadata/slice_info.config').decode('utf-8')
        patched = info.replace('key="printer_model_id" value=""', f'key="printer_model_id" value="{model_id}"')
        if patched == info:
            return
        tmp = f'{path}.tmp'
        with zipfile.ZipFile(tmp, 'w') as dst:
            for item in src.infolist():
                data = patched.encode('utf-8') if item.filename == 'Metadata/slice_info.config' else src.read(item)
                dst.writestr(item, data, compress_type=item.compress_type)
    os.replace(tmp, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--printer', default='Bambu Lab H2D')
    parser.add_argument('--nozzle', default=None, help='Installed nozzle diameter, e.g. 0.4')
    parser.add_argument('--bed-type', default=None, choices=BED_TYPES, help='Build plate on the printer; overrides the project')
    args = parser.parse_args()

    try:
        project = read_project_settings(args.input)
    except (OSError, zipfile.BadZipFile, ValueError) as err:
        fail('INVALID_3MF', f'Không đọc được file 3MF: {err}')

    project_printer = project.get('printer_model')
    project_nozzle = str(as_list(project.get('nozzle_diameter'))[0]) if project.get('nozzle_diameter') else None
    nozzle = args.nozzle or (project_nozzle if project_nozzle in SUPPORTED_NOZZLES else '0.4')

    workdir = tempfile.mkdtemp(prefix='slice-')
    try:
        if project_printer == args.printer and (args.nozzle is None or args.nozzle == project_nozzle):
            preset_args, profiles = [], None
        else:
            preset_args, profiles = retarget(project, args.printer, nozzle, workdir)

        # An explicit plate always wins; a re-targeted project keeps its plate when it names one
        project_bed = project.get('curr_bed_type') if project.get('curr_bed_type') in BED_TYPES else None
        bed_type = args.bed_type or (project_bed if profiles is None else project_bed or DEFAULT_BED_TYPE)
        bed_args = ['--curr-bed-type', bed_type] if bed_type and bed_type != project.get('curr_bed_type') else []

        outdir = os.path.join(workdir, 'out')
        os.makedirs(outdir)
        cmd = [
            os.path.join(STUDIO_DIR, 'bin', 'bambu-studio'),
            '--debug', '1',
            '--datadir', os.path.join(workdir, 'data'),
            *preset_args,
            *bed_args,
            '--slice', '0',
            '--outputdir', outdir,
            '--export-3mf', 'out.gcode.3mf',
            args.input,
        ]
        env = {**os.environ, 'LC_ALL': 'C', 'LD_LIBRARY_PATH': os.path.join(STUDIO_DIR, 'bin')}
        proc = subprocess.run(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors='replace')

        result = {}
        try:
            with open(os.path.join(outdir, 'result.json'), encoding='utf-8') as f:
                result = json.load(f)
        except (OSError, ValueError):
            pass
        output = os.path.join(outdir, 'out.gcode.3mf')
        if proc.returncode != 0 or result.get('return_code', 0) != 0 or not os.path.exists(output):
            fail(
                'SLICE_FAILED',
                f"Bambu Studio slice thất bại: {result.get('error_string') or f'exit code {proc.returncode}'}",
                exitCode=proc.returncode,
                stderr=proc.stderr[-2000:],
            )

        model_id = model_id_for(args.printer)
        if model_id:
            fill_printer_model_id(output, model_id)
        shutil.move(output, args.output)

        warnings = [p['warning_message'] for p in result.get('sliced_plates', []) if p.get('warning_message')]
        emit({
            'ok': True,
            'printer': args.printer,
            'sourcePrinter': project_printer,
            'nozzle': nozzle,
            'bedType': bed_type,
            'profiles': profiles,
            'warnings': warnings,
        }, 0)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == '__main__':
    main()
