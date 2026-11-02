import * as THREE from '../../../node_modules/three/build/three.module.js';

/* Interactive 3D model viewer: parts come from the model as simple primitives. */
const api = window.sidekick;
const cv = document.getElementById('cv');
const loading = document.getElementById('loading');
const loadtxt = document.getElementById('loadtxt');
const titleEl = document.getElementById('title');
const infoEl = document.getElementById('info');
const labelEl = document.getElementById('label');
const tagsEl = document.getElementById('tags');
const leadersEl = document.getElementById('leaders');
const factsEl = document.getElementById('facts');
const TAG_COLORS = ['#2ee6c5', '#ffc247', '#ff6b9a', '#9b8cff', '#5ec2ff', '#9be564'];
let labelsOn = true;
let tagItems = [];
let factItems = [];

const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
const pivot = new THREE.Group();
scene.add(pivot);
scene.add(new THREE.HemisphereLight(0xdbe8ff, 0x1a1f2b, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(4, 6, 5);
scene.add(key);
const rim = new THREE.DirectionalLight(0x3380ff, 1.4);
rim.position.set(-5, 2, -4);
scene.add(rim);

const view = { yaw: 0.6, pitch: 0.28, dist: 8.5, auto: true, vyaw: 0 };
const DEFAULT_VIEW = { yaw: 0.6, pitch: 0.28, dist: 8.5 };
let meshes = [];
let selected = null;
let currentModel = null;

function resize() {
  const r = cv.getBoundingClientRect();
  const w = Math.max(10, Math.floor(r.width));
  const h = Math.max(10, Math.floor(r.height));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(cv);

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function vec3(a, d) {
  const arr = Array.isArray(a) ? a : [];
  return [num(arr[0], d[0]), num(arr[1], d[1]), num(arr[2], d[2])];
}

function geometryFor(shape, size) {
  const [a, b, c] = size.map((v) => Math.max(0.02, Math.abs(v)));
  switch (shape) {
    case 'sphere': return new THREE.SphereGeometry(a, 40, 28);
    case 'cylinder': return new THREE.CylinderGeometry(a, a, b, 40);
    case 'cone': return new THREE.ConeGeometry(a, b, 40);
    case 'torus': return new THREE.TorusGeometry(a, Math.min(b, a * 0.9), 20, 56);
    case 'capsule': return new THREE.CapsuleGeometry(a, Math.max(0.02, b), 10, 24);
    default: return new THREE.BoxGeometry(a, b, c);
  }
}

function clearModel() {
  for (const m of meshes) {
    m.geometry.dispose();
    m.material.dispose();
    pivot.remove(m);
  }
  meshes = [];
  selected = null;
  tagsEl.innerHTML = '';
  leadersEl.innerHTML = '';
  factsEl.innerHTML = '';
  tagItems = [];
  factItems = [];
}

function buildModel(model) {
  clearModel();
  currentModel = model;
  const parts = (model.parts || []).slice(0, 60);
  parts.forEach((p, i) => {
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(/^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : '#6aa6ff'), roughness: 0.42, metalness: 0.15, emissive: 0x000000 });
    const mesh = new THREE.Mesh(geometryFor(p.shape, vec3(p.size, [1, 1, 1])), mat);
    const pos = vec3(p.position, [0, 0, 0]);
    mesh.position.set(pos[0], pos[1], pos[2]);
    const rot = vec3(p.rotation, [0, 0, 0]);
    mesh.rotation.set(THREE.MathUtils.degToRad(rot[0]), THREE.MathUtils.degToRad(rot[1]), THREE.MathUtils.degToRad(rot[2]));
    mesh.userData = { name: String(p.name || 'Part ' + (i + 1)), info: String(p.info || ''), base: mat.color.clone() };
    mesh.userData.delay = 0.04 * i;
    pivot.add(mesh);
    meshes.push(mesh);
  });
  // parts that enclose other parts (cell wall, shell, body) become glass so the inside stays visible
  meshes.forEach((m) => {
    m.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(m);
    const inside = meshes.filter((o) => o !== m && b.containsPoint(o.position)).length;
    if (inside >= 2) {
      m.material.transparent = true;
      m.material.opacity = 0.26;
      m.material.depthWrite = false;
      m.renderOrder = -1;
      m.userData.glass = true;
    }
  });
  // centre + fit
  pivot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(pivot);
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  meshes.forEach((m) => {
    m.position.sub(centre);
    m.scale.setScalar(0.001); // pop-in starts after bounds are measured at full size
  });
  const radius = Math.max(size.length() * 0.5, 0.5);
  const fov = THREE.MathUtils.degToRad(camera.fov) * 0.5;
  const fit = radius / Math.sin(Math.min(fov, Math.atan(Math.tan(fov) * camera.aspect)));
  view.dist = DEFAULT_VIEW.dist = Math.max(3.5, fit * 1.12);
  buildFacts();
  buildTags();
  titleEl.textContent = model.title || 'Model';
  setInfo(null);
  loading.classList.add('hide');
}

// One dark-glass note per part, with the one-line fact from the model JSON. Clicking a note
// selects the part (the bottom info bar still offers "Ask Sidekick").
function buildFacts() {
  const head = document.createElement('div');
  head.className = 'facts-head';
  head.innerHTML = 'Parts <span></span>';
  head.querySelector('span').textContent = String(meshes.length);
  factsEl.appendChild(head);
  meshes.forEach((mesh, i) => {
    const color = TAG_COLORS[i % TAG_COLORS.length];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'fact-card';
    card.style.setProperty('--tag', color);
    card.setAttribute('data-part-index', String(i));
    const name = document.createElement('span');
    name.className = 'fname';
    const dot = document.createElement('i');
    dot.className = 'fdot';
    name.appendChild(dot);
    name.appendChild(document.createTextNode(mesh.userData.name));
    const fact = document.createElement('span');
    fact.className = 'ffact';
    fact.textContent = mesh.userData.info || 'One of the parts of this model.';
    card.appendChild(name);
    card.appendChild(fact);
    card.addEventListener('click', () => {
      view.auto = false;
      setInfo(mesh);
    });
    factsEl.appendChild(card);
    factItems.push({ mesh, card });
  });
}

// Label the most important parts: biggest first, solid parts only, at most 9 so the view stays readable.
function buildTags() {
  const NS = 'http://www.w3.org/2000/svg';
  const ranked = meshes
    .filter((m) => !m.userData.glass)
    .map((m) => { const b = new THREE.Box3().setFromObject(m); const sz = b.getSize(new THREE.Vector3()); return { m, vol: sz.x * sz.y * sz.z }; })
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 9);
  ranked.forEach(({ m }, i) => {
    const color = TAG_COLORS[i % TAG_COLORS.length];
    const tag = document.createElement('div');
    tag.className = 'ptag hidden';
    tag.style.setProperty('--tag', color);
    tag.textContent = m.userData.name;
    tagsEl.appendChild(tag);
    const line = document.createElementNS(NS, 'line');
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('r', 3.5);
    [line, dot].forEach((e) => { e.style.setProperty('--tag', color); e.style.opacity = 0; leadersEl.appendChild(e); });
    tagItems.push({ mesh: m, tag, line, dot, w: 0, y: 0, offset: 30 + (i % 3) * 16 });
  });
}

const projV = new THREE.Vector3();
const tagRay = new THREE.Raycaster();
function updateTags() {
  const r = cv.getBoundingClientRect();
  const W = r.width;
  const H = r.height;
  const placed = [];
  for (const it of tagItems) {
    const show = labelsOn && it.mesh.scale.x > 0.95;
    projV.copy(it.mesh.position).project(camera);
    const px = (projV.x * 0.5 + 0.5) * W;
    const py = (-projV.y * 0.5 + 0.5) * H;
    // dimmed (not hidden) when something else is in front of the part: the label still says what is inside
    const visible = show && projV.z < 1;
    let covered = false;
    if (visible) {
      tagRay.setFromCamera({ x: projV.x, y: projV.y }, camera);
      const hit = tagRay.intersectObjects(meshes.filter((m) => !m.userData.glass), false)[0];
      covered = !!(hit && hit.object !== it.mesh);
    }
    if (!it.w) it.w = it.tag.offsetWidth || 60;
    const railRight = factsEl.offsetWidth ? factsEl.offsetLeft + factsEl.offsetWidth + 16 : 4;
    const minX = Math.max(4, Math.min(W - it.w - 4, railRight));
    let tx = Math.max(minX, Math.min(W - it.w - 4, px - it.w / 2));
    let ty = Math.max(4, py - it.offset - 22);
    // nudge down/up when two tags would sit on top of each other
    for (const p of placed) {
      if (Math.abs(p.x - tx) < Math.max(p.w, it.w) && Math.abs(p.y - ty) < 24) ty = p.y - 26 < 4 ? p.y + 26 : p.y - 26;
    }
    if (visible) placed.push({ x: tx, y: ty, w: it.w });
    it.tag.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px)`;
    it.tag.classList.toggle('hidden', !visible);
    it.tag.classList.toggle('dim', covered);
    it.tag.classList.toggle('sel', it.mesh === selected);
    it.line.setAttribute('x1', (tx + it.w / 2).toFixed(1));
    it.line.setAttribute('y1', (ty + 22).toFixed(1));
    it.line.setAttribute('x2', px.toFixed(1));
    it.line.setAttribute('y2', py.toFixed(1));
    it.dot.setAttribute('cx', px.toFixed(1));
    it.dot.setAttribute('cy', py.toFixed(1));
    it.line.style.opacity = it.dot.style.opacity = visible ? (covered ? 0.35 : 0.9) : 0;
  }
}

function setInfo(mesh) {
  selected = mesh;
  meshes.forEach((m) => {
    m.material.emissive.setHex(m === mesh ? 0x2255aa : 0x000000);
  });
  for (const f of factItems) f.card.classList.toggle('sel', f.mesh === mesh);
  if (!mesh) {
    infoEl.innerHTML = '<span class="muted">Drag to rotate, scroll to zoom, click a part or a note to learn about it.</span>';
    return;
  }
  const d = mesh.userData;
  infoEl.innerHTML = `<div><b></b><span class="secondary"></span></div><button class="btn btn-secondary ask">Ask Sidekick</button>`;
  infoEl.querySelector('b').textContent = d.name;
  infoEl.querySelector('span').textContent = d.info;
  infoEl.querySelector('.ask').addEventListener('click', () => {
    api.invoke('model3d:ask', { title: titleEl.textContent, part: d.name, info: d.info });
  });
}

// ---------------------------------------------------------------- interaction
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let drag = null;

function pick(clientX, clientY) {
  const r = cv.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(meshes, false)[0];
  return hit ? hit.object : null;
}

cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, moved: 0 };
  view.auto = false;
});
cv.addEventListener('pointermove', (e) => {
  if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    view.yaw -= dx * 0.008;
    view.pitch = Math.max(-1.35, Math.min(1.35, view.pitch + dy * 0.008));
  } else {
    const m = pick(e.clientX, e.clientY);
    cv.style.cursor = m ? 'pointer' : 'grab';
    if (m) {
      labelEl.textContent = m.userData.name;
      const r = cv.getBoundingClientRect();
      labelEl.style.left = e.clientX - r.left + 'px';
      labelEl.style.top = e.clientY - r.top + 'px';
      labelEl.classList.add('show');
    } else labelEl.classList.remove('show');
  }
});
cv.addEventListener('pointerup', (e) => {
  if (drag && drag.moved < 5) setInfo(pick(e.clientX, e.clientY));
  drag = null;
});
cv.addEventListener('pointerleave', () => labelEl.classList.remove('show'));
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  view.dist = Math.max(2.5, Math.min(30, view.dist * (1 + Math.sign(e.deltaY) * 0.08)));
}, { passive: false });
document.getElementById('labels-toggle').addEventListener('click', (e) => {
  labelsOn = !labelsOn;
  e.currentTarget.classList.toggle('on', labelsOn);
});
document.getElementById('reset').addEventListener('click', () => {
  Object.assign(view, DEFAULT_VIEW, { auto: true });
});
document.getElementById('close').addEventListener('click', () => api.invoke('window:control', { action: 'close' }));

// ---------------------------------------------------------------- loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (view.auto) view.yaw += dt * 0.35;
  camera.position.set(
    Math.sin(view.yaw) * Math.cos(view.pitch) * view.dist,
    Math.sin(view.pitch) * view.dist,
    Math.cos(view.yaw) * Math.cos(view.pitch) * view.dist
  );
  camera.lookAt(0, 0, 0);
  for (const m of meshes) {
    if (m.userData.delay > 0) m.userData.delay -= dt;
    else if (m.scale.x < 1) m.scale.setScalar(Math.min(1, m.scale.x + dt * 3.2 + (1 - m.scale.x) * dt * 6));
  }
  renderer.render(scene, camera);
  updateTags();
  requestAnimationFrame(frame);
}
resize();
requestAnimationFrame(frame);

api.on('model3d:show', (payload) => {
  if (!payload) return;
  if (payload.state === 'loading') {
    clearModel();
    titleEl.textContent = payload.topic || '3D model';
    loadtxt.textContent = 'Building ' + (payload.topic || 'model') + '...';
    loading.classList.remove('hide');
  } else if (payload.state === 'error') {
    loadtxt.textContent = payload.message || 'Could not build that model.';
    loading.classList.remove('hide');
    loading.querySelector('.spin').style.display = 'none';
  } else if (payload.model) {
    loading.querySelector('.spin').style.display = '';
    buildModel(payload.model);
  }
});
api.invoke('model3d:ready');
