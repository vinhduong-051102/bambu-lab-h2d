'use client';

import { CaretRightOutlined, CloseOutlined, ExperimentOutlined, PauseOutlined, ReloadOutlined, StepForwardOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Descriptions, Flex, InputNumber, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { formatNumber } from '../sim';
import { arrowLength, latestOnly, liveUrl, motorDisplay, norm, pace, threeQuaternion, toSi } from '../simLive';

/**
 * The interactive simulation viewer (docs/interactive-physics.md): a live Chrono session in the sim-live container,
 * drawn with three.js from the state it streams. Dragging a body sends the pointer to the session, which pulls the
 * body there with a finite force; the drawing only ever shows where Chrono put the bodies.
 *
 * A body drawn from several components (a 3D model's rigid group, docs/model-simulation.md) shows each component as
 * its own mesh, picked one by one; `inspect` then adds what the caller knows of the picked component, and the model
 * as it was made (every body at its starting pose) can be shown faintly beside the moving one.
 */

type Vec = [number, number, number];
type Geometry = { type?: string; size?: Vec; radius?: number; length?: number; axis?: 'x' | 'y' | 'z' };
type SceneBody = {
  id: string;
  name: string;
  fixed: boolean;
  geometry: Geometry;
  color: string | null;
  mass: number | null;
  collision: boolean;
  held: boolean;
  mesh: { url: string; unit_scale: number; format: string } | null;
  parts?: { id: string; name: string; color: string | null; url: string; unit_scale: number; format: string }[];
  initial?: { p: Vec; q: [number, number, number, number] };
};
type SceneMotor = { id: string; type: string; mode: string; unit: string; body_a: string; point: Vec; axis: Vec };
type LiveScene = {
  session_id: string;
  name: string;
  source: Record<string, string>;
  time_step: number;
  gravity: Vec;
  bodies: SceneBody[];
  joints: { id: string; type: string; body_a: string; point?: Vec; axis?: Vec }[];
  motors: SceneMotor[];
  warnings: { path: string; message: string }[];
  assumptions: { path: string; message: string }[];
  mechanism: unknown;
};
type LiveState = {
  t: number;
  running: boolean;
  failed: string | null;
  speed: number;
  rtf: number;
  behind: boolean;
  contacts: number;
  gravity: Vec;
  bodies: Record<string, { p: Vec; q: [number, number, number, number] }>;
  motors: Record<string, { value: number | null; rate: number | null; effort: number | null; enabled: boolean; setpoint: number | null; drift_correction: boolean }>;
  drag: { body: string; point: Vec; target: Vec; force: Vec } | null;
  selected: {
    body: string;
    mass: number | null;
    fixed: boolean;
    position: Vec;
    velocity: Vec;
    angular_velocity: Vec;
    acceleration: Vec;
    contact_force: Vec | null;
    applied_force: Vec;
    weight: Vec | null;
  } | null;
};

const MM = 1000;
const COLOURS = ['#3B82F6', '#D9A441', '#10B981', '#EF4444', '#8B5CF6', '#EC4899'];
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5];
const PUSH_DIRECTIONS: Record<string, Vec> = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1] };

async function call<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.message || `HTTP ${res.status}`);
  return data as T;
}

/** A body's shape in mm, in its own frame */
function shapeOf(b: SceneBody): THREE.BufferGeometry {
  const g = b.geometry ?? {};
  if (g.type === 'box' && g.size) return new THREE.BoxGeometry(g.size[0] * MM, g.size[1] * MM, g.size[2] * MM);
  if (g.type === 'sphere' && g.radius) return new THREE.SphereGeometry(g.radius * MM, 32, 16);
  if ((g.type === 'cylinder' || g.type === 'gear') && g.radius && g.length) {
    // three's cylinder lies along Y
    const shape = new THREE.CylinderGeometry(g.radius * MM, g.radius * MM, g.length * MM, 48);
    if (g.axis === 'z' || !g.axis) shape.rotateX(Math.PI / 2);
    if (g.axis === 'x') shape.rotateZ(-Math.PI / 2);
    return shape;
  }
  // No geometry, or a mesh still loading: a small marker
  return new THREE.SphereGeometry(4, 12, 8);
}

async function loadMesh(sessionId: string, b: SceneBody): Promise<THREE.BufferGeometry | null> {
  return b.mesh ? loadGeometry(sessionId, b.id, b.mesh) : null;
}

/** A mesh the session serves (a body's, or `<body>.part<k>` for one of its components), in mm */
async function loadGeometry(sessionId: string, key: string, mesh: { unit_scale: number; format: string }): Promise<THREE.BufferGeometry | null> {
  const res = await fetch(liveUrl(sessionId, `/mesh/${encodeURIComponent(key)}`), { cache: 'no-store' });
  if (!res.ok) return null;
  const data = await res.arrayBuffer();
  let geometry: THREE.BufferGeometry | null = null;
  const b = { mesh };
  if (b.mesh.format === 'stl') geometry = new STLLoader().parse(data);
  else if (b.mesh.format === 'ply') geometry = new PLYLoader().parse(data);
  else if (b.mesh.format === 'obj') {
    const group = new OBJLoader().parse(new TextDecoder().decode(data));
    const first = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    geometry = first ? first.geometry : null;
  }
  if (!geometry) return null;
  geometry.scale(b.mesh.unit_scale * MM, b.mesh.unit_scale * MM, b.mesh.unit_scale * MM);
  geometry.computeVertexNormals();
  return geometry;
}

/** A joint or motor axis drawn on its body_a: a short rod along the axis */
function axisMarker(point: Vec, axis: Vec, color: string): THREE.Mesh {
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 30, 12), new THREE.MeshBasicMaterial({ color }));
  rod.position.set(point[0] * MM, point[1] * MM, point[2] * MM);
  rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...axis).normalize());
  return rod;
}

const vec3 = (v: Vec) => new THREE.Vector3(v[0] * MM, v[1] * MM, v[2] * MM);

/** What a caller may show of the picked component, from the latest state */
export type LivePick = { body: string; part: string | null; state: LiveState; scene: LiveScene };
export type { LiveState, LiveScene };

export function SimLive({
  sessionId,
  onClose,
  inspect,
  title,
}: {
  sessionId: string;
  onClose: () => void;
  /** Extra panel for the picked body or component (a 3D model's part data and results) */
  inspect?: (pick: LivePick) => ReactNode;
  title?: ReactNode;
}) {
  const { message } = App.useApp();
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<LiveState | null>(null);
  const [scene, setScene] = useState<LiveScene | null>(null);
  const [state, setState] = useState<LiveState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transport, setTransport] = useState<'stream' | 'polling' | 'ended'>('stream');
  const [pushDir, setPushDir] = useState('+Z');
  const [pushN, setPushN] = useState<number | null>(null);
  const [setpoints, setSetpoints] = useState<Record<string, number | null>>({});
  const [picked, setPicked] = useState<{ body: string; part: string | null } | null>(null);
  const [ghost, setGhost] = useState(false);
  const ghostRef = useRef<THREE.Group | null>(null);
  const pickedRef = useRef<{ body: string; part: string | null } | null>(null);

  const act = useCallback(
    async (action: Record<string, unknown>, quiet = false) => {
      try {
        const data = await call<{ state: LiveState }>(liveUrl(sessionId, '/actions'), action);
        stateRef.current = data.state;
        setState(data.state);
      } catch (err) {
        if (!quiet) message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId, message]
  );

  // The scene, once
  useEffect(() => {
    call<{ scene: LiveScene; state: LiveState }>(liveUrl(sessionId))
      .then((data) => {
        setScene(data.scene);
        stateRef.current = data.state;
        setState(data.state);
      })
      .catch((err) => setError(err.message));
  }, [sessionId]);

  // The state: streamed, or polled when the stream cannot be had; the panel re-renders at most 8 times a second
  useEffect(() => {
    let poll: ReturnType<typeof setInterval> | null = null;
    let shown = 0;
    const take = (next: LiveState) => {
      stateRef.current = next;
      const now = performance.now();
      if (now - shown > 125) {
        shown = now;
        setState(next);
      }
    };
    const source = new EventSource(liveUrl(sessionId, '/stream?hz=30'));
    source.onmessage = (event) => take(JSON.parse(event.data));
    source.addEventListener('end', () => {
      source.close();
      setTransport('ended');
    });
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED || poll) return;
      setTransport('polling');
      poll = setInterval(() => {
        call<{ state: LiveState }>(liveUrl(sessionId, '/state'))
          .then((data) => take(data.state))
          .catch(() => {
            if (poll) clearInterval(poll);
            setTransport('ended');
          });
      }, 100);
    };
    return () => {
      source.close();
      if (poll) clearInterval(poll);
    };
  }, [sessionId]);

  // The 3D view: built once the scene is known, drawn every frame from the latest state
  useEffect(() => {
    const mount = mountRef.current;
    if (!scene || !mount) return;
    const width = mount.clientWidth;
    const height = mount.clientHeight;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);
    const world = new THREE.Scene();
    world.background = new THREE.Color('#0b1220');
    const camera = new THREE.PerspectiveCamera(45, width / height, 1, 100000);
    camera.up.set(0, 0, 1);
    world.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(400, -600, 900);
    world.add(sun);

    // Frame the bodies as they start
    const start = stateRef.current;
    const box = new THREE.Box3();
    for (const b of scene.bodies) {
      const p = start?.bodies[b.id]?.p;
      if (p) box.expandByPoint(vec3(p));
    }
    const centre = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const span = Math.max(150, box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length());
    camera.position.copy(centre).add(new THREE.Vector3(span * 1.2, -span * 1.6, span * 1.0));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(centre);
    // Left button drags bodies; the camera turns with the right button and pans with the middle one
    controls.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    controls.update();
    const grid = new THREE.GridHelper(Math.max(400, span * 3), 20, 0x475569, 0x1e293b);
    grid.rotateX(Math.PI / 2);
    world.add(grid);
    world.add(new THREE.AxesHelper(50));

    const groups = new Map<string, THREE.Group>();
    const pickable: THREE.Mesh[] = [];
    // The model as made: every body at its starting pose, faint, shown on demand
    const original = new THREE.Group();
    original.visible = false;
    world.add(original);
    ghostRef.current = original;
    const ghostMaterial = new THREE.MeshBasicMaterial({ color: '#94A3B8', transparent: true, opacity: 0.18, depthWrite: false });
    const addGhost = (b: SceneBody, mesh: THREE.Mesh) => {
      if (!b.initial) return;
      const copy = new THREE.Mesh(mesh.geometry, ghostMaterial);
      copy.position.set(b.initial.p[0] * MM, b.initial.p[1] * MM, b.initial.p[2] * MM);
      const [x, y, z, w] = threeQuaternion(b.initial.q);
      copy.quaternion.set(x, y, z, w);
      original.add(copy);
    };
    scene.bodies.forEach((b, i) => {
      const group = new THREE.Group();
      const colour = (c: string | null | undefined) => c ?? b.color ?? (b.fixed ? '#4B5563' : COLOURS[i % COLOURS.length]);
      const pieces = b.parts?.length ? b.parts : [null];
      for (const [k, part] of pieces.entries()) {
        const material = new THREE.MeshStandardMaterial({ color: colour(part?.color), roughness: 0.55, metalness: 0.1 });
        const mesh = new THREE.Mesh(part ? new THREE.SphereGeometry(2, 8, 6) : shapeOf(b), material);
        mesh.userData.bodyId = b.id;
        mesh.userData.partId = part?.id ?? null;
        group.add(mesh);
        pickable.push(mesh);
        const loading = part ? loadGeometry(sessionId, `${b.id}.part${k}`, part) : b.mesh ? loadMesh(sessionId, b) : null;
        if (loading) {
          loading
            .then((geometry) => {
              if (geometry) {
                mesh.geometry.dispose();
                mesh.geometry = geometry;
              }
              addGhost(b, mesh);
            })
            .catch(() => {});
        } else {
          addGhost(b, mesh);
        }
      }
      groups.set(b.id, group);
      world.add(group);
    });
    for (const j of scene.joints) {
      if (j.point && j.axis) groups.get(j.body_a)?.add(axisMarker(j.point, j.axis, '#F59E0B'));
    }
    for (const m of scene.motors) groups.get(m.body_a)?.add(axisMarker(m.point, m.axis, '#EF4444'));

    // What the session reports, drawn over the bodies
    const dragLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: '#F8FAFC', dashSize: 4, gapSize: 3 }));
    dragLine.visible = false;
    world.add(dragLine);
    const dragArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, 0xf8fafc);
    const speedArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, 0x22c55e);
    const contactArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, 0xf97316);
    for (const arrow of [dragArrow, speedArrow, contactArrow]) {
      arrow.visible = false;
      world.add(arrow);
    }
    const showArrow = (arrow: THREE.ArrowHelper, at: THREE.Vector3, v: Vec | null | undefined, length: number) => {
      arrow.visible = Boolean(v) && length > 0.5;
      if (!arrow.visible || !v) return;
      arrow.position.copy(at);
      arrow.setDirection(new THREE.Vector3(...v).normalize());
      arrow.setLength(length, Math.min(10, length * 0.3), Math.min(6, length * 0.2));
    };

    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const s = stateRef.current;
      const pick = pickedRef.current;
      for (const mesh of pickable) {
        const on = Boolean(pick && mesh.userData.bodyId === pick.body && (pick.part === null || mesh.userData.partId === pick.part));
        (mesh.material as THREE.MeshStandardMaterial).emissive?.setHex(on ? 0x334155 : 0x000000);
      }
      if (s) {
        for (const [id, pose] of Object.entries(s.bodies)) {
          const group = groups.get(id);
          if (!group) continue;
          group.position.set(pose.p[0] * MM, pose.p[1] * MM, pose.p[2] * MM);
          const [x, y, z, w] = threeQuaternion(pose.q);
          group.quaternion.set(x, y, z, w);
        }
        const d = s.drag;
        dragLine.visible = Boolean(d);
        if (d) {
          dragLine.geometry.setFromPoints([vec3(d.point), vec3(d.target)]);
          dragLine.computeLineDistances();
        }
        const sel = s.selected;
        const weight = sel?.weight ? norm(sel.weight) : 1;
        showArrow(dragArrow, d ? vec3(d.point) : new THREE.Vector3(), d?.force, d ? arrowLength(norm(d.force), weight / 50) : 0);
        const at = sel && s.bodies[sel.body] ? vec3(s.bodies[sel.body].p) : new THREE.Vector3();
        showArrow(speedArrow, at, sel?.velocity, sel ? arrowLength(norm(sel.velocity), 1 / 200) : 0);
        showArrow(contactArrow, at, sel?.contact_force, sel?.contact_force ? arrowLength(norm(sel.contact_force), weight / 50) : 0);
      }
      controls.update();
      renderer.render(world, camera);
    };
    draw();

    // ---------- pointer: pick, select, drag ----------
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const send = latestOnly((action: Record<string, unknown>) => call(liveUrl(sessionId, '/actions'), action).catch(() => {}));
    let grab: { body: string; part: string | null; fixed: boolean; hit: THREE.Vector3; plane: THREE.Plane; x: number; y: number; dragging: boolean } | null = null;
    const ray = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      ray(e);
      const hit = raycaster.intersectObjects(pickable, false)[0];
      if (!hit) return;
      const id = hit.object.userData.bodyId as string;
      const body = scene.bodies.find((b) => b.id === id);
      // Shift: drag on the horizontal plane through the point; otherwise on the plane facing the camera
      const normal = e.shiftKey ? new THREE.Vector3(0, 0, 1) : camera.getWorldDirection(new THREE.Vector3());
      grab = { body: id, part: (hit.object.userData.partId as string | null) ?? null, fixed: Boolean(body?.fixed), hit: hit.point.clone(), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point), x: e.clientX, y: e.clientY, dragging: false };
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!grab || grab.fixed) return;
      if (!grab.dragging && Math.hypot(e.clientX - grab.x, e.clientY - grab.y) < 4) return;
      ray(e);
      const target = raycaster.ray.intersectPlane(grab.plane, new THREE.Vector3());
      if (!target) return;
      const toSi3 = (v: THREE.Vector3) => [v.x / MM, v.y / MM, v.z / MM];
      if (!grab.dragging) {
        grab.dragging = true;
        // The point grabbed, where the ray first hit the body; then only where the pointer is
        send({ action: 'drag', body: grab.body, point: toSi3(grab.hit), target: toSi3(target) });
      } else {
        send({ action: 'drag', body: grab.body, target: toSi3(target) });
      }
    };
    const up = (e: PointerEvent) => {
      if (!grab) return;
      const { body, part, dragging } = grab;
      grab = null;
      renderer.domElement.releasePointerCapture(e.pointerId);
      if (dragging) {
        // After the last target, so the release is not overtaken by a move still being sent
        setTimeout(() => act({ action: 'release' }, true), 50);
      } else {
        pickedRef.current = { body, part };
        setPicked({ body, part });
        act({ action: 'select', body }, true);
      }
    };
    const element = renderer.domElement;
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      controls.dispose();
      world.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
      element.remove();
    };
  }, [scene, sessionId, act]);

  useEffect(() => {
    if (ghostRef.current) ghostRef.current.visible = ghost;
  }, [ghost, scene]);

  const stop = async () => {
    await call(liveUrl(sessionId, '/stop'), {}).catch(() => {});
    onClose();
  };

  /** The same mechanism through the offline pipeline: full results, checks, and the Blender video */
  const runOffline = async () => {
    if (!scene) return;
    try {
      let body: Record<string, unknown>;
      if (scene.source.mechanism_id) body = { mechanism_id: scene.source.mechanism_id };
      else if (scene.mechanism) body = { mechanism: scene.mechanism };
      else throw new Error('Phiên này không có cơ cấu gốc để chạy ngoại tuyến.');
      const data = await call<{ sim_id: string }>('/api/sim/runs', body);
      message.success(`Đã xếp lần chạy ngoại tuyến ${data.sim_id}: xem ở danh sách bên dưới.`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  const selectedBody = useMemo(() => scene?.bodies.find((b) => b.id === state?.selected?.body) ?? null, [scene, state?.selected?.body]);
  const sel = state?.selected ?? null;
  const weightN = sel?.weight ? norm(sel.weight) : 0;
  const p = pace(state);
  const gravityOn = state ? norm(state.gravity) > 0 : true;

  if (error) {
    return <Alert type="error" showIcon title={`Không mở được phiên tương tác: ${error}`} action={<Button size="small" onClick={onClose}>Đóng</Button>} />;
  }

  return (
    <Card
      size="small"
      title={
        <Space wrap>
          {title ?? <>🎮 {scene?.name ?? 'Phiên tương tác'}</>}
          <Tag color={p.color}>{p.text}</Tag>
          {transport !== 'stream' && <Tag color={transport === 'ended' ? 'error' : 'warning'}>{transport === 'ended' ? 'Phiên đã kết thúc' : 'Đang hỏi trạng thái định kỳ'}</Tag>}
        </Space>
      }
      extra={
        <Space>
          <Button size="small" icon={<ExperimentOutlined />} onClick={runOffline} disabled={!scene} title="Chạy cùng cơ cấu ngoại tuyến: kết quả đầy đủ, kiểm tra và video Blender">
            Chạy ngoại tuyến
          </Button>
          <Button size="small" danger icon={<CloseOutlined />} onClick={stop}>
            Dừng phiên
          </Button>
        </Space>
      }
    >
      <Flex gap={16} wrap>
        <div style={{ flex: '1 1 560px', minWidth: 0 }}>
          <div ref={mountRef} style={{ width: '100%', height: 520, borderRadius: 8, overflow: 'hidden', touchAction: 'none', cursor: 'grab' }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Chuột trái kéo vật (giữ Shift: kéo trên mặt phẳng ngang) · click chọn vật · chuột phải xoay, chuột giữa dịch, lăn chuột
            phóng to. Mũi tên trắng: lực kéo · xanh lá: vận tốc · cam: lực tiếp xúc của vật đang chọn.
          </Typography.Text>
        </div>
        <Flex vertical gap={12} style={{ flex: '1 1 320px', minWidth: 280 }}>
          {state?.failed && <Alert type="error" showIcon title={state.failed} description="Reset để chạy lại." />}
          <Space wrap>
            {state?.running ? (
              <Button icon={<PauseOutlined />} onClick={() => act({ action: 'pause' })}>Tạm dừng</Button>
            ) : (
              <Button type="primary" icon={<CaretRightOutlined />} disabled={Boolean(state?.failed)} onClick={() => act({ action: 'resume' })}>Chạy</Button>
            )}
            <Button icon={<StepForwardOutlined />} disabled={Boolean(state?.failed)} onClick={() => act({ action: 'step', count: 1 })} title="Một bước thời gian">1 bước</Button>
            <Button disabled={Boolean(state?.failed) || !scene} onClick={() => scene && act({ action: 'step', count: Math.max(1, Math.round(0.01 / scene.time_step)) })}>+10 ms</Button>
            <Button icon={<ReloadOutlined />} onClick={() => act({ action: 'reset' })}>Reset</Button>
          </Space>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="t">{state ? `${state.t.toFixed(3)} s` : '–'}</Descriptions.Item>
            <Descriptions.Item label="Bước">{scene ? `${formatNumber(scene.time_step * 1000)} ms` : '–'}</Descriptions.Item>
            <Descriptions.Item label="Tiếp xúc">{state?.contacts ?? '–'}</Descriptions.Item>
            <Descriptions.Item label="Tốc độ">
              <Select size="small" value={state?.speed ?? 1} onChange={(value) => act({ action: 'speed', value })} options={SPEEDS.map((v) => ({ value: v, label: `×${v}` }))} style={{ width: 80 }} />
            </Descriptions.Item>
            <Descriptions.Item label="Mô hình gốc" span={2}>
              <Switch size="small" checked={ghost} onChange={setGhost} />{' '}
              <Typography.Text type="secondary">vị trí ban đầu, mờ, cạnh mô hình đang chạy</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="Trọng lực" span={2}>
              <Switch
                size="small"
                checked={gravityOn}
                onChange={(on) => scene && act({ action: 'gravity', vector: on ? scene.gravity : [0, 0, 0] })}
              />{' '}
              <Typography.Text type="secondary">{state ? `${state.gravity.map((g) => formatNumber(g)).join(', ')} m/s²` : ''}</Typography.Text>
            </Descriptions.Item>
          </Descriptions>

          {scene && scene.motors.length > 0 && (
            <Table
              size="small"
              pagination={false}
              rowKey="id"
              dataSource={scene.motors}
              columns={[
                { title: 'Motor', dataIndex: 'id', render: (id: string, m: SceneMotor) => <span title={`${m.type} · ${m.mode}`}>{id}</span> },
                {
                  title: 'Hiện tại',
                  render: (_: unknown, m: SceneMotor) => {
                    const live = state?.motors[m.id];
                    const shown = m.mode === 'speed' ? live?.rate : m.mode === 'angle' || m.mode === 'position' ? live?.value : live?.effort;
                    const d = motorDisplay(m.unit);
                    return shown === null || shown === undefined ? '–' : `${formatNumber(shown * d.scale)} ${d.unit}`;
                  },
                },
                {
                  title: 'Đặt',
                  render: (_: unknown, m: SceneMotor) => {
                    const d = motorDisplay(m.unit);
                    return (
                      <Space.Compact>
                        <InputNumber size="small" style={{ width: 96 }} value={setpoints[m.id] ?? null} placeholder={d.unit} onChange={(v) => setSetpoints((s) => ({ ...s, [m.id]: v }))} />
                        <Button size="small" disabled={setpoints[m.id] === null || setpoints[m.id] === undefined} onClick={() => act({ action: 'motor', id: m.id, value: toSi(setpoints[m.id] as number, m.unit) })}>
                          Đặt
                        </Button>
                      </Space.Compact>
                    );
                  },
                },
                {
                  title: 'Bật',
                  render: (_: unknown, m: SceneMotor) => <Switch size="small" checked={state?.motors[m.id]?.enabled ?? true} onChange={(on) => act({ action: 'motor', id: m.id, enabled: on })} />,
                },
              ]}
            />
          )}

          {inspect && picked && state && scene && inspect({ ...picked, state, scene })}
          <Card size="small" title={selectedBody ? `Vật đang chọn: ${selectedBody.name}` : 'Click một vật để xem thông số'}>
            {sel && selectedBody ? (
              <Flex vertical gap={8}>
                <Descriptions size="small" column={1}>
                  <Descriptions.Item label="Khối lượng">{sel.mass === null ? 'cố định' : `${formatNumber(sel.mass * 1000)} g`}</Descriptions.Item>
                  <Descriptions.Item label="Vận tốc">{`${formatNumber(norm(sel.velocity) * 1000)} mm/s`}</Descriptions.Item>
                  <Descriptions.Item label="Gia tốc">{`${formatNumber(norm(sel.acceleration))} m/s²`}</Descriptions.Item>
                  {sel.contact_force && <Descriptions.Item label="Lực tiếp xúc">{`${formatNumber(norm(sel.contact_force))} N`}</Descriptions.Item>}
                  <Descriptions.Item label="Lực người dùng">{`${formatNumber(norm(sel.applied_force))} N`}</Descriptions.Item>
                  {sel.weight && <Descriptions.Item label="Trọng lượng">{`${formatNumber(weightN)} N`}</Descriptions.Item>}
                </Descriptions>
                {!sel.fixed && (
                  <Space.Compact>
                    <Select size="small" value={pushDir} onChange={setPushDir} options={Object.keys(PUSH_DIRECTIONS).map((k) => ({ value: k, label: k }))} style={{ width: 64 }} />
                    <InputNumber size="small" min={0} style={{ width: 110 }} value={pushN ?? Number((weightN * 3).toPrecision(2))} onChange={setPushN} suffix="N" />
                    <Button
                      size="small"
                      onClick={() => {
                        const n = pushN ?? Number((weightN * 3).toPrecision(2));
                        act({ action: 'push', body: sel.body, force: PUSH_DIRECTIONS[pushDir].map((c) => c * n), duration: 0.1 });
                      }}
                    >
                      Đẩy 0.1 s
                    </Button>
                  </Space.Compact>
                )}
              </Flex>
            ) : (
              <Typography.Text type="secondary">Chưa chọn vật nào.</Typography.Text>
            )}
          </Card>

          {scene && (scene.warnings.length > 0 || scene.assumptions.length > 0) && (
            <Alert
              type="info"
              showIcon
              title="Giả định của mô hình"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {[...scene.warnings, ...scene.assumptions].map((a, i) => (
                    <li key={i}>{a.message}</li>
                  ))}
                </ul>
              }
            />
          )}
        </Flex>
      </Flex>
    </Card>
  );
}
