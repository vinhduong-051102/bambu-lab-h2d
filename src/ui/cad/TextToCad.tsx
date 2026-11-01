'use client';

import { CheckCircleFilled, CloseCircleFilled, DownloadOutlined, InfoCircleFilled, ReloadOutlined } from '@ant-design/icons';
import { Alert, App, Button, Empty, Flex, Modal, Space, Spin, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { fileUrl } from '../cad';
import type { CadJob } from './CadJob';

/**
 * What text-to-cad (docs/text-to-cad.md) adds to a technical model's card: the model in 3D from its GLB, an
 * engineering drawing, a DfAM check and the files Claude made with text-to-cad's other skills.
 */

const POLL_MS = 3000;

type TaskField = 'drawing_task' | 'dfam_task';

/**
 * POST `action` on the job, which runs in the gateway and goes on when the page closes; while its task (`field`)
 * runs, the job is read again until it is done. Returns [running, start, the job as last read]
 */
function useJobTask(given: CadJob, action: 'drawing' | 'dfam', field: TaskField) {
  const { message } = App.useApp();
  const [asked, setAsked] = useState(false);
  // The card's own copy is read again only while the model is being made: the answers here are newer
  const [read, setRead] = useState<CadJob | null>(null);
  const job = read && read.id === given.id && (read.finished_at ?? '') >= (given.finished_at ?? '') ? read : given;
  const onJob = setRead;
  const running = asked || Boolean(job[field]?.running);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/cad/jobs/${encodeURIComponent(job.id)}`, { cache: 'no-store' }).catch(() => null);
      const data = res?.ok ? await res.json().catch(() => null) : null;
      const task = data?.job?.[field] as CadJob[TaskField];
      if (!task || task.running) return;
      setAsked(false);
      if (task.error) message.error(task.error);
      onJob?.(data.job);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, job.id, field, message]);

  const start = async () => {
    setAsked(true);
    let goesOn = false;
    try {
      const res = await fetch(`/api/cad/jobs/${encodeURIComponent(job.id)}/${action}`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (data?.job) onJob?.(data.job);
      if (!res.ok || !data?.success) {
        message.error(data?.message ?? data?.drawing?.error ?? `Không chạy được (HTTP ${res.status}).`);
        return;
      }
      goesOn = res.status === 202;
    } finally {
      if (!goesOn) setAsked(false);
    }
  };
  return [running, start, job] as const;
}

/** "📐 Bản vẽ": the engineering drawing (cadgen.eng_drawing), made on the first click and opened after */
export function DrawingButton(props: { job: CadJob }) {
  const [running, start, job] = useJobTask(props.job, 'drawing', 'drawing_task');
  if (!job.files?.drawing || running) {
    return (
      <Button size="small" loading={running} onClick={start} title="Bản vẽ kỹ thuật PDF khổ A3: 3 hình chiếu, isometric, nét khuất, kích thước bao (text-to-cad)">
        📐 Vẽ bản vẽ
      </Button>
    );
  }
  return (
    <Space.Compact>
      <Button size="small" href={`${fileUrl(job, 'drawing.pdf')}&d=${encodeURIComponent(job.drawing_task?.finished_at ?? '')}`} target="_blank" rel="noopener noreferrer">
        📐 Bản vẽ
      </Button>
      <Button size="small" icon={<ReloadOutlined />} onClick={start} title="Vẽ lại từ mô hình hiện tại" />
    </Space.Compact>
  );
}

const STATUS_ICONS = {
  pass: <CheckCircleFilled style={{ color: '#52c41a' }} />,
  fail: <CloseCircleFilled style={{ color: '#ff4d4f' }} />,
  info: <InfoCircleFilled style={{ color: '#1677ff' }} />,
};

/** "🧪 DfAM": text-to-cad's printability check of what is printed, against FDM limits */
export function DfamButton(props: { job: CadJob }) {
  const [open, setOpen] = useState(false);
  const [running, start, job] = useJobTask(props.job, 'dfam', 'dfam_task');
  const dfam = job.dfam;
  const fails = dfam?.findings?.filter((f) => f.status === 'fail').length ?? 0;
  return (
    <>
      <Button
        size="small"
        loading={running && !open}
        onClick={() => {
          setOpen(true);
          if (!dfam && !running) void start();
        }}
        title="Kiểm tra in 3D (DfAM, text-to-cad): lưới kín, thành mỏng, phần nhô cần support, hướng đặt ít support hơn"
      >
        🧪 DfAM{dfam?.ok ? (fails ? ` · ${fails} lỗi` : ' · đạt') : ''}
      </Button>
      <Modal open={open} onCancel={() => setOpen(false)} footer={null} width={640} title={`Kiểm tra DfAM · ${job.title || job.id}`}>
        {running ? (
          <Flex vertical align="center" gap={8} style={{ padding: 32 }}>
            <Spin />
            <Typography.Text type="secondary">Đang đo độ dày thành và phần nhô (vài chục giây với lưới lớn)…</Typography.Text>
          </Flex>
        ) : !dfam ? (
          <Empty description="Chưa kiểm tra">
            <Button onClick={start}>Kiểm tra</Button>
          </Empty>
        ) : !dfam.ok ? (
          <Alert type="error" showIcon title={dfam.error ?? 'Không kiểm tra được.'} action={<Button size="small" onClick={start}>Thử lại</Button>} />
        ) : (
          <Flex vertical gap={10}>
            {dfam.partial && <Alert type="warning" showIcon title="Có phần chưa đo được: các mục đó không được tính là đạt." />}
            {dfam.findings?.map((f, i) => (
              <Flex key={i} gap={8} align="start">
                {STATUS_ICONS[f.status]}
                <div>
                  <Typography.Text strong>{f.title}</Typography.Text>
                  <div>
                    <Typography.Text type="secondary">{f.detail}</Typography.Text>
                  </div>
                </div>
              </Flex>
            ))}
            <Flex justify="space-between" align="center">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {dfam.process} · {dfam.source}
              </Typography.Text>
              <Space>
                <Button size="small" href={fileUrl(job, 'dfam.json')} target="_blank" rel="noopener noreferrer">
                  Số đo
                </Button>
                <Button size="small" icon={<ReloadOutlined />} onClick={start}>
                  Kiểm tra lại
                </Button>
              </Space>
            </Flex>
          </Flex>
        )}
      </Modal>
    </>
  );
}

/** The model as designed, from cadgen's GLB: turn it with the mouse; an assembly's motions play as its clips */
function GlbView({ src }: { src: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [clips, setClips] = useState<string[]>([]);
  const playRef = useRef<(name: string) => void>(() => {});

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f1f5f9');
    const environment = new THREE.PMREMGenerator(renderer);
    scene.environment = environment.fromScene(new RoomEnvironment(), 0.04).texture;
    const camera = new THREE.PerspectiveCamera(40, mount.clientWidth / mount.clientHeight, 0.0001, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    let mixer: THREE.AnimationMixer | null = null;
    let disposed = false;

    new GLTFLoader().load(
      src,
      (gltf) => {
        if (disposed) return;
        scene.add(gltf.scene);
        // Framed whatever its unit: a glTF is in metres, Y up
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const centre = box.getCenter(new THREE.Vector3());
        const span = box.getSize(new THREE.Vector3()).length() || 1;
        camera.near = span / 1000;
        camera.far = span * 100;
        camera.updateProjectionMatrix();
        camera.position.copy(centre).add(new THREE.Vector3(span * 0.8, span * 0.6, span * 0.9));
        controls.target.copy(centre);
        const grid = new THREE.GridHelper(span * 2, 20, 0x94a3b8, 0xcbd5e1);
        grid.position.set(centre.x, box.min.y, centre.z);
        scene.add(grid);
        if (gltf.animations.length) {
          mixer = new THREE.AnimationMixer(gltf.scene);
          setClips(gltf.animations.map((clip) => clip.name));
          playRef.current = (name) => {
            mixer?.stopAllAction();
            const clip = gltf.animations.find((c) => c.name === name);
            if (clip) mixer?.clipAction(clip).reset().play();
          };
        }
      },
      undefined,
      () => setError('Không mở được file GLB.')
    );

    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      mixer?.update(clock.getDelta());
      controls.update();
      renderer.render(scene, camera);
    });
    const resize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener('resize', resize);
    return () => {
      disposed = true;
      window.removeEventListener('resize', resize);
      renderer.setAnimationLoop(null);
      controls.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
        }
      });
      environment.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [src]);

  return (
    <Flex vertical gap={8}>
      {error && <Alert type="error" showIcon title={error} />}
      <div ref={mountRef} style={{ width: '100%', height: 'min(70vh, 640px)', borderRadius: 6, overflow: 'hidden' }} />
      <Flex justify="space-between" align="center" gap={8} wrap>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Chuột trái: xoay · chuột phải: kéo · cuộn: phóng to
        </Typography.Text>
        {clips.length > 0 && (
          <Space wrap size={4}>
            {clips.map((name) => (
              <Button key={name} size="small" onClick={() => playRef.current(name)}>
                ▶ {name}
              </Button>
            ))}
          </Space>
        )}
      </Flex>
    </Flex>
  );
}

/** "🧊 Xem 3D": the GLB, with its download */
export function ModelViewerButton({ job }: { job: CadJob }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)} title="Xem mô hình 3D: xoay, phóng to, màu từng chi tiết (GLB từ cadgen)">
        🧊 Xem 3D
      </Button>
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={
          <Button size="small" icon={<DownloadOutlined />} href={fileUrl(job, 'model.glb', true)}>
            GLB
          </Button>
        }
        width="min(1100px, 96vw)"
        destroyOnHidden
        title={`3D · ${job.title || job.id}`}
      >
        {open && <GlbView src={`${fileUrl(job, 'model.glb')}&f=${encodeURIComponent(job.finished_at ?? '')}`} />}
      </Modal>
    </>
  );
}

/** The files Claude made with text-to-cad's other skills (out/exports/), each a download */
export function ExportLinks({ job }: { job: CadJob }) {
  if (!job.exports?.length) return null;
  return (
    <>
      {job.exports.map((name) => (
        <Button
          key={name}
          size="small"
          icon={<DownloadOutlined />}
          href={`/api/cad/jobs/${encodeURIComponent(job.id)}/exports/${encodeURIComponent(name)}?download=1`}
          title="File Claude làm thêm bằng skill text-to-cad"
        >
          {name}
        </Button>
      ))}
    </>
  );
}
