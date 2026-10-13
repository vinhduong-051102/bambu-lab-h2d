import { strFromU8, unzipSync } from 'fflate';
import { featureColor, parseGcode, TRAVEL } from './gcodeToolpath';

/**
 * 3D toolpath preview of a staged .gcode.3mf plate, like Bambu Studio's Preview tab: a layer
 * slider, orbit/zoom, and per-feature visibility. Everything runs in the browser (three.js is
 * loaded on demand); the gateway only serves the file, so this costs the Pi nothing.
 */

// H2D build plate, mm
const BED_WIDTH = 350;
const BED_DEPTH = 320;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child !== null && child !== undefined) node.append(child);
  return node;
}

export function openGcodePreview({ stagedId, plateIndex, fileName, showToast }) {
  const status = el('div', { className: 'gcode-preview-status', text: 'Đang tải file…' });
  const viewport = el('div', { className: 'gcode-preview-viewport' }, [status]);
  const layerSlider = el('input', { type: 'range', min: '0', max: '0', value: '0', className: 'gcode-preview-slider', disabled: '' });
  const layerLabel = el('span', { className: 'gcode-preview-layer', text: '—' });
  const onlyLayer = el('input', { type: 'checkbox', id: 'gcodeOnlyLayer' });
  const legend = el('div', { className: 'gcode-preview-legend' });
  const closeBtn = el('button', { type: 'button', className: 'btn-close-modal', 'aria-label': 'Đóng', text: '×' });

  const backdrop = el('div', { className: 'modal-backdrop open gcode-preview-backdrop' }, [
    el('div', { className: 'modal-content gcode-preview-modal', role: 'dialog', 'aria-label': 'Xem 3D đường in' }, [
      el('div', { className: 'modal-header' }, [
        el('h3', { text: `🧊 ${fileName} · Plate ${plateIndex}` }),
        closeBtn,
      ]),
      viewport,
      el('div', { className: 'gcode-preview-controls' }, [
        el('div', { className: 'gcode-preview-layer-row' }, [
          layerLabel,
          el('label', { className: 'gcode-preview-check' }, [onlyLayer, ' Chỉ layer này']),
        ]),
        layerSlider,
        legend,
        el('div', { className: 'print-muted gcode-preview-hint', text: 'Kéo chuột để xoay · cuộn để zoom · chuột phải để di chuyển · ↑/↓ đổi layer' }),
      ]),
    ]),
  ]);
  document.body.append(backdrop);

  let disposed = false;
  let cleanupScene = () => {};
  const onKey = (event) => {
    if (event.key === 'Escape') close();
    if (layerSlider.disabled) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      layerSlider.value = String(Number(layerSlider.value) + (event.key === 'ArrowUp' ? 1 : -1));
      layerSlider.dispatchEvent(new Event('input'));
    }
  };
  function close() {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('keydown', onKey);
    cleanupScene();
    backdrop.remove();
  }
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);

  (async () => {
    const res = await fetch(`/api/print/staged/${encodeURIComponent(stagedId)}/file`);
    if (!res.ok) throw new Error(`Không tải được file (HTTP ${res.status}).`);
    const archive = new Uint8Array(await res.arrayBuffer());
    if (disposed) return;

    status.textContent = 'Đang đọc G-code…';
    // Let the status repaint before the synchronous unzip + parse
    await new Promise((resolve) => setTimeout(resolve, 30));
    const entryName = `Metadata/plate_${plateIndex}.gcode`;
    const entries = unzipSync(archive, { filter: (file) => file.name === entryName });
    if (!entries[entryName]) throw new Error(`File không có G-code cho plate ${plateIndex}.`);
    const toolpath = parseGcode(strFromU8(entries[entryName]));
    if (!toolpath.bounds) throw new Error('G-code không có đường đùn nhựa nào để hiển thị.');

    const [THREE, { OrbitControls }] = await Promise.all([import('three'), import('three/addons/controls/OrbitControls.js')]);
    if (disposed) return;
    status.remove();
    cleanupScene = buildScene(THREE, OrbitControls, toolpath, { viewport, layerSlider, layerLabel, onlyLayer, legend });
  })().catch((err) => {
    if (disposed) return;
    status.textContent = `❌ ${err.message}`;
    showToast?.(err.message, 'error');
  });
}

function buildScene(THREE, OrbitControls, toolpath, ui) {
  const { viewport, layerSlider, layerLabel, onlyLayer, legend } = ui;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x0b0f17);
  viewport.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
  camera.up.set(0, 0, 1); // G-code is Z-up

  // Build plate outline + 10 mm grid
  const grid = [];
  for (let x = 0; x <= BED_WIDTH; x += 10) grid.push(x, 0, 0, x, BED_DEPTH, 0);
  for (let y = 0; y <= BED_DEPTH; y += 10) grid.push(0, y, 0, BED_WIDTH, y, 0);
  const gridGeometry = new THREE.BufferGeometry();
  gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));
  const gridMaterial = new THREE.LineBasicMaterial({ color: 0x1f2937 });
  scene.add(new THREE.LineSegments(gridGeometry, gridMaterial));
  const outlineGeometry = new THREE.BufferGeometry();
  outlineGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, BED_WIDTH, 0, 0, BED_WIDTH, BED_DEPTH, 0, 0, BED_DEPTH, 0], 3)
  );
  const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x4b5563 });
  scene.add(new THREE.LineLoop(outlineGeometry, outlineMaterial));

  // One LineSegments per feature; vertices are ordered by layer, so a layer range is a draw range
  const layers = toolpath.layers;
  const objects = toolpath.features.map((feature) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(feature.positions, 3));
    const isTravel = feature.name === TRAVEL;
    const material = new THREE.LineBasicMaterial({
      color: featureColor(feature.name),
      transparent: isTravel,
      opacity: isTravel ? 0.35 : 1,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.visible = !isTravel;
    lines.frustumCulled = false;
    scene.add(lines);
    return { feature, geometry, material, lines };
  });

  // Frame the printed object
  const { min, max } = toolpath.bounds;
  const center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 20);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  camera.position.set(center.x + size * 0.9, center.y - size * 1.6, center.z + size * 1.1);
  controls.update();

  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render);

  const resize = () => {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(viewport);

  const applyLayer = () => {
    const layer = Number(layerSlider.value);
    for (const { feature, geometry } of objects) {
      const end = feature.layerEnds[layer];
      const start = onlyLayer.checked && layer > 0 ? feature.layerEnds[layer - 1] : 0;
      geometry.setDrawRange(start, end - start);
    }
    const z = layers[layer]?.z;
    layerLabel.textContent = `Layer ${layer + 1}/${layers.length}${typeof z === 'number' && Number.isFinite(z) ? ` · Z ${z.toFixed(2)} mm` : ''}`;
    render();
  };

  layerSlider.max = String(layers.length - 1);
  layerSlider.value = String(layers.length - 1);
  layerSlider.disabled = false;
  layerSlider.addEventListener('input', applyLayer);
  onlyLayer.addEventListener('change', applyLayer);

  legend.replaceChildren(
    ...objects
      .slice()
      .sort((a, b) => (a.feature.name === TRAVEL) - (b.feature.name === TRAVEL) || a.feature.name.localeCompare(b.feature.name))
      .map(({ feature, lines }) => {
        const checkbox = el('input', { type: 'checkbox' });
        checkbox.checked = lines.visible;
        checkbox.addEventListener('change', () => {
          lines.visible = checkbox.checked;
          render();
        });
        const swatch = el('span', { className: 'gcode-preview-swatch' });
        swatch.style.background = featureColor(feature.name);
        const label = feature.name === TRAVEL ? 'Di chuyển (travel)' : feature.name;
        return el('label', { className: 'gcode-preview-check' }, [checkbox, swatch, ` ${label}`]);
      })
  );

  applyLayer();
  resize();

  return () => {
    observer.disconnect();
    controls.dispose();
    for (const { geometry, material } of objects) {
      geometry.dispose();
      material.dispose();
    }
    gridGeometry.dispose();
    gridMaterial.dispose();
    outlineGeometry.dispose();
    outlineMaterial.dispose();
    renderer.dispose();
  };
}
