import * as THREE from 'three';
import { directorPose, type DirectorScene } from './director-scene.js';

// Same renderer and frame sampling power the editor and offscreen production job.
export function createDirectorRenderer(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  let scene: THREE.Scene | undefined;
  function release() {
    scene?.traverse((o: any) => {
      o.geometry?.dispose();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m?.dispose();
    });
    scene?.clear();
  }
  function draw(data: DirectorScene, frame: number) {
    release();
    scene = new THREE.Scene();
    scene.background = new THREE.Color(data.background);
    renderer.setSize(data.width, data.height, false);
    scene.add(new THREE.AmbientLight('#ffffff', data.light.ambient));
    const light = new THREE.DirectionalLight('#ffffff', data.light.intensity);
    light.position.set(data.light.position.x, data.light.position.y, data.light.position.z);
    scene.add(light);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({ color: '#d9d6e5', roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    scene.add(ground);
    scene.add(new THREE.GridHelper(30, 30, '#9b93bb', '#bfb9d0'));
    for (const object of data.objects) {
      const pose = directorPose(object.keys, frame),
        s = object.size;
      const geometry =
        object.shape === 'person'
          ? new THREE.CapsuleGeometry(
              Math.min(s.x, s.z) / 2,
              Math.max(0.01, s.y - Math.min(s.x, s.z)),
              6,
              12,
            )
          : object.shape === 'sphere'
            ? new THREE.SphereGeometry(0.5, 20, 12)
            : object.shape === 'cylinder'
              ? new THREE.CylinderGeometry(s.x / 2, s.x / 2, s.y, 20)
              : new THREE.BoxGeometry(s.x, s.y, s.z);
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: object.color, roughness: 0.75 }),
      );
      if (object.shape === 'sphere') mesh.scale.set(s.x, s.y, s.z);
      mesh.position.set(pose.position.x, pose.position.y + s.y / 2, pose.position.z);
      mesh.rotation.set(
        (pose.rotation.x * Math.PI) / 180,
        (pose.rotation.y * Math.PI) / 180,
        (pose.rotation.z * Math.PI) / 180,
      );
      scene.add(mesh);
      if (object.shape === 'person') {
        const arrow = new THREE.ArrowHelper(
          new THREE.Vector3(
            Math.sin((pose.rotation.y * Math.PI) / 180),
            0,
            -Math.cos((pose.rotation.y * Math.PI) / 180),
          ),
          new THREE.Vector3(pose.position.x, pose.position.y + s.y, pose.position.z),
          0.7,
          '#8c65e9',
        );
        scene.add(arrow);
      }
    }
    const camera = new THREE.PerspectiveCamera(45, data.width / data.height, 0.05, 5000);
    camera.setFocalLength(data.camera.focalLength);
    const p = directorPose(data.camera.keys, frame);
    camera.position.set(p.position.x, p.position.y, p.position.z);
    camera.lookAt(data.camera.target.x, data.camera.target.y, data.camera.target.z);
    camera.rotateX((p.rotation.x * Math.PI) / 180);
    camera.rotateY((p.rotation.y * Math.PI) / 180);
    camera.rotateZ((p.rotation.z * Math.PI) / 180);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  }
  return {
    draw,
    png: () => canvas.toDataURL('image/png'),
    dispose() {
      release();
      renderer.dispose();
    },
  };
}
