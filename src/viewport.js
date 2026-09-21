import { localizedError as i18nError } from "./i18n.js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { loadMesh, modelKind, disposeObject } from "./models.js";
import { extension } from "./core.js";
const radians = THREE.MathUtils.degToRad;
const normalVS =
  "varying vec3 N; varying float Z; void main(){vec4 p=modelViewMatrix*vec4(position,1.);N=normalize(normalMatrix*normal);Z=-p.z;gl_Position=projectionMatrix*p;}";
function dataMaterial(mode, settings) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      nearZ: { value: settings.depthNear },
      farZ: { value: settings.depthFar },
    },
    vertexShader: normalVS,
    fragmentShader:
      mode === "normal"
        ? "varying vec3 N; void main(){gl_FragColor=vec4(normalize(N)*.5+.5,1.);}"
        : mode === "depth"
          ? "varying float Z; uniform float nearZ; uniform float farZ; void main(){float d=clamp((Z-nearZ)/(farZ-nearZ),0.,1.);gl_FragColor=vec4(vec3(d),1.);}"
          : "void main(){gl_FragColor=vec4(1.);}",
  });
}
export class Viewport {
  constructor(
    element,
    settings,
    { onCamera = () => {}, onError = () => {}, interactive = true } = {},
  ) {
    this.element = element;
    this.settings = { ...settings };
    this.onCamera = onCamera;
    this.onError = onError;
    this.scene = new THREE.Scene();
    this.token = 0;
    this.disposed = false;
    this.ready = false;
    this.saving = false;
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    element.append(this.renderer.domElement);
    this.perspective = new THREE.PerspectiveCamera(
      settings.fov,
      1,
      0.01,
      10000,
    );
    this.orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10000);
    this.camera = this.perspective;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enabled = interactive;
    this.controls.enableDamping = false;
    this.controls.minDistance = 0.05;
    this.controls.maxDistance = 10000;
    this.controls.addEventListener("change", () => {
      if (!this.applying) {
        this.onCamera(this.cameraRecord());
        this.draw();
      }
    });
    this.lights = new THREE.Group();
    this.scene.add(this.lights);
    this.lights.add(new THREE.HemisphereLight(0xffffff, 0x7d8790, 0.8));
    for (let i = 0; i < 3; i++)
      this.lights.add(new THREE.DirectionalLight(0xffffff, 1));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(element);
    this.resize();
    this.setSettings(settings);
    this.pose(settings.azimuth, settings.elevation, settings.distance);
    this.renderer.setAnimationLoop(() => {
      if (this.ready && !this.saving) this.draw();
    });
  }
  resize() {
    if (this.saving || this.disposed) return;
    const size = Math.max(
      64,
      Math.min(
        this.element.clientWidth || 320,
        this.element.clientHeight || 320,
      ),
    );
    this.renderer.setSize(size, size, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.draw();
  }
  async clear() {
    this.ready = false;
    if (this.root) {
      this.scene.remove(this.root);
      disposeObject(this.root);
      this.root = null;
    }
    if (this.splats) {
      const s = this.splats;
      this.splats = null;
      await s.dispose();
    }
    if (this.blobURL) {
      URL.revokeObjectURL(this.blobURL);
      this.blobURL = null;
    }
    this.sourceBox = null;
  }
  async load(record, files) {
    const token = ++this.token;
    await this.clear();
    if (this.disposed || token !== this.token) return;
    this.record = record;
    this.files = files;
    const file = files.get(record.path);
    if (!file) throw i18nError("modelDisconnected");
    this.kind = await modelKind(file, record.path);
    if (this.kind === "gaussian") {
      const { Viewer, SceneFormat } =
        await import("@mkkellogg/gaussian-splats-3d");
      if (this.disposed || token !== this.token) return;
      this.splats = new Viewer({
        renderer: this.renderer,
        camera: this.camera,
        threeScene: this.scene,
        rootElement: this.element,
        selfDrivenMode: false,
        useBuiltInControls: false,
        sharedMemoryForWorkers: false,
        gpuAcceleratedSort: false,
        integerBasedSort: false,
        ignoreDevicePixelRatio: true,
        dynamicScene: true,
        sceneRevealMode: 2,
        kernel2DSize: 0.1,
      });
      this.blobURL = URL.createObjectURL(file);
      const ext = extension(record.path);
      await this.splats.addSplatScene(this.blobURL, {
        format:
          ext === "ply"
            ? SceneFormat.Ply
            : ext === "ksplat"
              ? SceneFormat.KSplat
              : SceneFormat.Splat,
        showLoadingUI: false,
        progressiveLoad: false,
        splatAlphaRemovalThreshold: 0,
      });
      if (this.disposed || token !== this.token) return;
      this.sourceBox = this.splats.getSplatMesh().computeBoundingBox(false);
      this.stats = {
        type: "Gaussian",
        primitives: this.splats.getSplatMesh().getSplatCount(),
      };
      if (record.surface_path && files.has(record.surface_path)) {
        this.root = await loadMesh(
          { ...record, path: record.surface_path },
          files,
        );
        this.prepareRoot();
      }
    } else {
      const object = await loadMesh(record, files);
      if (this.disposed || token !== this.token) {
        disposeObject(object);
        return;
      }
      this.root = object;
      this.sourceBox = new THREE.Box3().setFromObject(object);
      let triangles = 0,
        points = 0;
      object.traverse((o) => {
        if (o.isMesh)
          triangles +=
            (o.geometry.index?.count || o.geometry.attributes.position.count) /
            3;
        if (o.isPoints) points += o.geometry.attributes.position.count;
      });
      this.stats = {
        type: points && !triangles ? "Point cloud" : "Mesh",
        primitives: triangles || points,
      };
      this.prepareRoot();
    }
    this.transform();
    this.ready = true;
    this.setSettings(this.settings);
    this.draw();
    return this.stats;
  }
  prepareRoot() {
    const raw = this.root;
    this.root = new THREE.Group();
    this.root.add(raw);
    this.scene.add(this.root);
    raw.traverse((o) => {
      if (o.isMesh) {
        const source = Array.isArray(o.material) ? o.material : [o.material];
        o.userData.sourceMaterials = source;
        o.userData.arrayMaterial = Array.isArray(o.material);
        o.userData.materials = {};
        o.userData.materials.color = source.map(
          (m) =>
            new THREE.MeshBasicMaterial({
              color: m.color?.clone() || new THREE.Color(0xffffff),
              map: m.map || null,
              vertexColors: !!o.geometry.attributes.color,
              side: THREE.DoubleSide,
              transparent: !!m.transparent,
              opacity: m.opacity ?? 1,
              alphaTest: m.alphaTest || 0,
            }),
        );
        o.userData.materials.relight = source.map(
          (m) =>
            new THREE.MeshStandardMaterial({
              color: m.color?.clone() || new THREE.Color(0xffffff),
              map: m.map || null,
              normalMap: m.normalMap || null,
              roughnessMap: m.roughnessMap || null,
              metalnessMap: m.metalnessMap || null,
              vertexColors: !!o.geometry.attributes.color,
              roughness: m.roughness ?? 0.6,
              metalness: m.metalness ?? 0,
              side: THREE.DoubleSide,
              transparent: !!m.transparent,
              opacity: m.opacity ?? 1,
              alphaTest: m.alphaTest || 0,
            }),
        );
        o.userData.materials.clay = [
          new THREE.MeshStandardMaterial({
            color: 0xb0b8b2,
            roughness: 0.7,
            metalness: 0,
            side: THREE.DoubleSide,
          }),
        ];
        for (const mode of ["normal", "depth", "mask"])
          o.userData.materials[mode] = [dataMaterial(mode, this.settings)];
        o.userData.studioMaterials = [
          ...source,
          ...Object.values(o.userData.materials).flat(),
        ];
      }
    });
  }
  transform() {
    if (!this.sourceBox) return;
    const r = this.record,
      rotation = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(...r.rotation.map(radians)),
      );
    const axis = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        r.up === "Z" ? -Math.PI / 2 : 0,
        0,
        r.up === "X" ? Math.PI / 2 : 0,
      ),
    );
    rotation.multiply(axis);
    const size = this.sourceBox.getSize(new THREE.Vector3()),
      factor =
        (this.settings.normalize
          ? 1 / Math.max(size.x, size.y, size.z, 1e-9)
          : 1) * r.scale;
    const center = this.sourceBox.getCenter(new THREE.Vector3());
    const offset = this.settings.normalize
      ? center.clone().multiplyScalar(-factor).applyQuaternion(rotation)
      : new THREE.Vector3();
    if (this.root) {
      this.root.position.copy(offset);
      this.root.quaternion.copy(rotation);
      this.root.scale.setScalar(factor);
      this.root.updateMatrixWorld(true);
    }
    if (this.splats) {
      const scene = this.splats.getSplatScene(0);
      scene.position.copy(offset);
      scene.quaternion.copy(rotation);
      scene.scale.setScalar(factor);
      scene.updateMatrixWorld(true);
    }
    this.normalization = {
      enabled: this.settings.normalize,
      source_center: center.toArray(),
      source_extent: size.toArray(),
      scale: factor,
      position: offset.toArray(),
      quaternion: rotation.toArray(),
    };
  }
  supported(mode) {
    if (mode === "color") return true;
    if (this.stats?.type === "Point cloud") return false;
    return !!this.root;
  }
  setSettings(settings) {
    this.settings = { ...settings };
    const previous = this.cameraRecord();
    const next =
      settings.projection === "orthographic"
        ? this.orthographic
        : this.perspective;
    if (this.camera !== next) {
      this.camera = next;
      this.controls.object = next;
      if (this.splats) this.splats.camera = next;
      this.applyCamera(previous);
    }
    this.perspective.fov = settings.fov;
    this.perspective.updateProjectionMatrix();
    const half = settings.orthoSpan / 2;
    Object.assign(this.orthographic, {
      left: -half,
      right: half,
      top: half,
      bottom: -half,
    });
    this.orthographic.updateProjectionMatrix();
    this.transform();
    this.element.dataset.background = settings.background;
    const mode = settings.mode;
    this.effectiveMode = this.supported(mode) ? mode : "color";
    this.unsupported = mode !== this.effectiveMode;
    if (this.root) {
      this.root.visible = this.effectiveMode !== "color" || !this.splats;
      this.root.traverse((o) => {
        if (!o.isMesh) return;
        const variants = o.userData.materials;
        if (!variants) return;
        let mats = variants[this.effectiveMode] || variants.color;
        for (const m of variants.depth) {
          m.uniforms.nearZ.value = settings.depthNear;
          m.uniforms.farZ.value = settings.depthFar;
        }
        o.material = mats.length === 1 ? mats[0] : mats;
      });
    }
    const data = ["normal", "depth", "mask"].includes(this.effectiveMode);
    this.renderer.outputColorSpace = data
      ? THREE.LinearSRGBColorSpace
      : THREE.SRGBColorSpace;
    this.renderer.toneMapping = ["relight", "clay"].includes(this.effectiveMode)
      ? THREE.ACESFilmicToneMapping
      : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = settings.exposure;
    this.draw();
  }
  lightRig() {
    const s = this.settings,
      forward = this.camera.position
        .clone()
        .sub(this.controls.target)
        .normalize(),
      right = new THREE.Vector3()
        .crossVectors(this.camera.up, forward)
        .normalize(),
      up = this.camera.up.clone();
    const presets = {
      studio: [
        [2.8, 2.4, 3.5],
        [-2, 1, 2],
        [-1, 2, -3],
      ],
      soft: [
        [1, 3, 3],
        [-2, 2, 2],
        [2, 2, -2],
      ],
      rim: [
        [1, 2, 2],
        [-2, 1, 1],
        [0, 2, -4],
      ],
    };
    const powers =
      s.light === "rim"
        ? [1.6, 0.5, 4]
        : s.light === "soft"
          ? [2, 1.5, 1.8]
          : [3, 1.1, 2.4];
    this.lights.children[0].intensity =
      (s.light === "soft" ? 1.2 : 0.65) * s.intensity;
    for (let i = 0; i < 3; i++) {
      const light = this.lights.children[i + 1],
        [x, y, z] = presets[s.light][i];
      light.position
        .copy(this.controls.target)
        .addScaledVector(right, x)
        .addScaledVector(up, y)
        .addScaledVector(forward, z);
      light.intensity = powers[i] * s.intensity;
      light.target.position.copy(this.controls.target);
      light.target.updateMatrixWorld();
    }
  }
  draw() {
    if (this.disposed) return;
    this.lightRig();
    if (this.splats && this.effectiveMode === "color") {
      this.splats.update();
      this.splats.render();
    } else this.renderer.render(this.scene, this.camera);
  }
  pose(az, el, distance) {
    this.applying = true;
    const a = radians(az),
      e = radians(el);
    this.camera.position
      .set(
        Math.sin(a) * Math.cos(e) * distance,
        Math.sin(e) * distance,
        Math.cos(a) * Math.cos(e) * distance,
      )
      .add(this.controls.target);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.applying = false;
    this.draw();
  }
  cameraRecord() {
    return {
      position: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
      up: this.camera.up.toArray(),
      zoom: this.camera.zoom,
      fov: this.perspective.fov,
      projection: this.camera.isOrthographicCamera
        ? "orthographic"
        : "perspective",
      orthoSpan: this.settings.orthoSpan,
    };
  }
  applyCamera(p) {
    if (!p?.position || !p.target) return;
    this.applying = true;
    this.camera.position.fromArray(p.position);
    this.controls.target.fromArray(p.target);
    this.camera.up.fromArray(p.up || [0, 1, 0]);
    this.camera.zoom = p.zoom || 1;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.applying = false;
    this.draw();
  }
  fit() {
    this.controls.target.set(0, 0, 0);
    let d = this.settings.distance;
    if (!this.settings.normalize && this.sourceBox) {
      const sphere = this.sourceBox.getBoundingSphere(new THREE.Sphere());
      this.controls.target.copy(sphere.center);
      d = Math.max(sphere.radius * 3, 0.3);
    }
    this.pose(this.settings.azimuth, this.settings.elevation, d);
    this.onCamera(this.cameraRecord());
  }
  async capture(mode, size) {
    if (!this.ready) throw i18nError("modelNotLoaded");
    if (!this.supported(mode))
      throw i18nError(
        this.kind === "gaussian" ? "gaussianPass" : "pointCloudPass",
      );
    if (
      size > this.renderer.capabilities.maxTextureSize ||
      size >
        this.renderer
          .getContext()
          .getParameter(this.renderer.getContext().MAX_RENDERBUFFER_SIZE)
    )
      throw i18nError("exportSize");
    const old = { ...this.settings };
    this.saving = true;
    try {
      this.setSettings({ ...old, mode });
      this.renderer.setSize(size, size, false);
      this.draw();
      if (this.splats && mode === "color") {
        if (this.splats.sortPromise) await this.splats.sortPromise;
        this.splats.update();
        if (this.splats.sortPromise) await this.splats.sortPromise;
        this.draw();
      }
      const blob = await new Promise((resolve, reject) =>
        this.renderer.domElement.toBlob(
          (b) => (b ? resolve(b) : reject(i18nError("pngEncoding"))),
          "image/png",
        ),
      );
      return blob;
    } finally {
      this.saving = false;
      this.setSettings(old);
      this.resize();
    }
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.token++;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    await this.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
