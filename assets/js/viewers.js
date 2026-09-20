(() => {
  'use strict';

  const RESULTS_ROOT = 'https://rishit-dagli.github.io/squeeze3d-web-results';
  const BACKGROUND_COLOR = 0xf5f5f5;
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');
  const THREE_SCRIPTS = [
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/OBJLoader.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/MTLLoader.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/PLYLoader.min.js'
  ];
  let threeRuntimePromise = null;
  let imageComparisonRuntimePromise = null;

  function loadScript(source) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = source;
      script.crossOrigin = 'anonymous';
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error(`Unable to load ${source}`)), {
        once: true
      });
      document.head.appendChild(script);
    });
  }

  function loadStylesheet(source) {
    return new Promise((resolve, reject) => {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = source;
      stylesheet.addEventListener('load', resolve, { once: true });
      stylesheet.addEventListener('error', () => reject(new Error(`Unable to load ${source}`)), {
        once: true
      });
      document.head.appendChild(stylesheet);
    });
  }

  function ensureThreeRuntime() {
    if (
      window.THREE?.OrbitControls &&
      window.THREE?.OBJLoader &&
      window.THREE?.MTLLoader &&
      window.THREE?.PLYLoader
    ) {
      return Promise.resolve();
    }

    if (!threeRuntimePromise) {
      threeRuntimePromise = THREE_SCRIPTS.reduce(
        (chain, source) => chain.then(() => loadScript(source)),
        Promise.resolve()
      );
    }
    return threeRuntimePromise;
  }

  function ensureImageComparisonRuntime() {
    if (window.customElements?.get('img-comparison-slider')) return Promise.resolve();
    if (!imageComparisonRuntimePromise) {
      imageComparisonRuntimePromise = Promise.all([
        loadStylesheet('https://cdn.jsdelivr.net/npm/img-comparison-slider@8/dist/styles.css'),
        loadScript('https://cdn.jsdelivr.net/npm/img-comparison-slider@8/dist/index.js')
      ]);
    }
    return imageComparisonRuntimePromise;
  }

  function loadWith(loader, url) {
    return new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    });
  }

  async function fetchResource(url, signal, responseType) {
    const response = await fetch(url, { mode: 'cors', signal });
    if (!response.ok) throw new Error(`Unable to load ${url} (${response.status})`);
    return response[responseType]();
  }

  function isAbortError(error) {
    return error?.name === 'AbortError';
  }

  function disposeMaterial(material) {
    if (!material) return;

    for (const value of Object.values(material)) {
      if (value && value.isTexture) value.dispose();
    }
    material.dispose();
  }

  function disposeObject(object) {
    if (!object) return;

    object.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach(disposeMaterial);
      } else {
        disposeMaterial(child.material);
      }
    });
  }

  class ThreeComparisonViewer {
    constructor(container, options) {
      this.container = container;
      this.options = options;
      this.split = 0.5;
      this.autoRotate = !REDUCED_MOTION.matches;
      this.beforeObject = null;
      this.afterObject = null;
      this.animationFrame = null;
      this.isVisible = false;
      this.isReady = false;
      this.isDisposed = false;
      this.isTicking = false;
      this.lastFrameTime = 0;
      this.renderWidth = 1;
      this.renderHeight = 1;
      this.abortController = new AbortController();
      this.loader = this.container.querySelector('.comparison-loader');

      this.tick = this.tick.bind(this);
      this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
      this.resize = this.resize.bind(this);

      this.initialize().catch((error) => {
        if (!this.isDisposed && !isAbortError(error)) {
          this.showError('The 3D viewer could not be loaded.');
        }
      });
    }

    async initialize() {
      if (!window.THREE) {
        this.showError('The 3D viewer could not be loaded.');
        return;
      }

      this.divider = this.container.querySelector('.comparison-divider');
      this.rotationToggle = this.container.querySelector('.comparison-rotation-toggle');

      this.beforeScene = this.createScene();
      this.afterScene = this.createScene();
      this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
      this.camera.position.set(0, 0, 4);

      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'default',
        preserveDrawingBuffer: false
      });
      this.renderer.autoClear = false;
      this.renderer.setClearColor(BACKGROUND_COLOR, 1);
      this.renderer.setPixelRatio(1);
      this.renderer.domElement.setAttribute(
        'aria-label',
        `${this.options.beforeLabel} and ${this.options.afterLabel} interactive 3D comparison`
      );
      this.container.prepend(this.renderer.domElement);

      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.12;
      this.controls.screenSpacePanning = false;
      this.controls.addEventListener('start', () => {
        this.autoRotate = false;
        this.updateRotationButton();
        this.startAnimation();
      });
      this.controls.addEventListener('change', () => {
        if (!this.autoRotate && !this.isTicking) this.render();
      });
      this.controls.addEventListener('end', () => this.startAnimation());

      this.setupDivider();
      this.setupRotationToggle();
      this.setupObservers();
      this.resize();
      this.updateRotationButton();

      const [beforeResult, afterResult] = await Promise.allSettled([
        this.loadAsset(this.options.beforeUrl),
        this.loadAsset(this.options.afterUrl)
      ]);

      if (this.isDisposed) {
        if (beforeResult.status === 'fulfilled') disposeObject(beforeResult.value);
        if (afterResult.status === 'fulfilled') disposeObject(afterResult.value);
        return;
      }

      if (beforeResult.status === 'fulfilled') {
        this.beforeObject = beforeResult.value;
        this.beforeScene.add(this.beforeObject);
      }
      if (afterResult.status === 'fulfilled') {
        this.afterObject = afterResult.value;
        this.afterScene.add(this.afterObject);
      }

      if (!this.beforeObject && !this.afterObject) {
        this.showError('The comparison could not be loaded.');
        return;
      }
      if (beforeResult.status === 'rejected' && !isAbortError(beforeResult.reason)) {
        this.showSideError('before', `${this.options.beforeLabel} failed to load`);
      }
      if (afterResult.status === 'rejected' && !isAbortError(afterResult.reason)) {
        this.showSideError('after', `${this.options.afterLabel} failed to load`);
      }

      this.fitCamera();
      this.isReady = true;
      if (this.loader) this.loader.hidden = true;
      this.render();
      this.startAnimation();
    }

    createScene() {
      const scene = new THREE.Scene();

      if (this.options.kind === 'mesh') {
        scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 1.1));
        const keyLight = new THREE.DirectionalLight(0xffffff, 0.75);
        keyLight.position.set(2, 3, 4);
        scene.add(keyLight);
      }

      return scene;
    }

    async loadAsset(url) {
      return this.options.kind === 'mesh'
        ? this.loadMesh(url)
        : this.loadPointCloud(url);
    }

    async loadMesh(baseUrl) {
      const signal = this.abortController.signal;
      const [objectText, materialText] = await Promise.all([
        fetchResource(`${baseUrl}mesh.obj`, signal, 'text'),
        fetchResource(`${baseUrl}mesh.mtl`, signal, 'text').catch((error) => {
          if (isAbortError(error)) throw error;
          return null;
        })
      ]);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      let materials = null;
      const materialLoader = new THREE.MTLLoader();
      materialLoader.setCrossOrigin('anonymous');
      materialLoader.setResourcePath(baseUrl);

      if (materialText) {
        materials = materialLoader.parse(materialText, baseUrl);
        materials.preload();
      }

      const objectLoader = new THREE.OBJLoader();
      if (materials) objectLoader.setMaterials(materials);
      const object = objectLoader.parse(objectText);

      if (!materials) {
        let texture = null;
        try {
          const textureLoader = new THREE.TextureLoader();
          const textureBlob = await fetchResource(`${baseUrl}mesh.png`, signal, 'blob');
          const textureUrl = URL.createObjectURL(textureBlob);
          try {
            texture = await loadWith(textureLoader, textureUrl);
          } finally {
            URL.revokeObjectURL(textureUrl);
          }
          texture.encoding = THREE.sRGBEncoding;
        } catch (error) {
          if (isAbortError(error)) {
            disposeObject(object);
            throw error;
          }
          texture = null;
        }

        object.traverse((child) => {
          if (!child.isMesh) return;
          if (child.material) disposeMaterial(child.material);
          child.material = new THREE.MeshPhongMaterial({
            color: texture ? 0xffffff : 0xc9c9c9,
            map: texture
          });
        });
      }

      object.rotation.x = -Math.PI / 2;
      object.updateMatrixWorld(true);
      this.centerObject(object);
      return object;
    }

    async loadPointCloud(url) {
      const signal = this.abortController.signal;
      const data = await fetchResource(url, signal, 'arrayBuffer');
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const loader = new THREE.PLYLoader();
      const geometry = loader.parse(data);
      geometry.computeBoundingBox();

      const material = new THREE.PointsMaterial({
        color: geometry.hasAttribute('color') ? 0xffffff : 0x3273dc,
        size: 0.05,
        sizeAttenuation: true,
        vertexColors: geometry.hasAttribute('color')
      });
      const points = new THREE.Points(geometry, material);
      this.centerObject(points);
      return points;
    }

    centerObject(object) {
      const box = new THREE.Box3().setFromObject(object);
      const center = box.getCenter(new THREE.Vector3());
      object.position.sub(center);
      object.updateMatrixWorld(true);
    }

    fitCamera() {
      const bounds = new THREE.Box3();
      if (this.beforeObject) bounds.expandByObject(this.beforeObject);
      if (this.afterObject) bounds.expandByObject(this.afterObject);

      const size = bounds.getSize(new THREE.Vector3());
      const maxDimension = Math.max(size.x, size.y, size.z, 0.1);
      const distance = (maxDimension * 0.68) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));

      this.camera.position.set(0, 0, distance);
      this.camera.near = Math.max(distance / 100, 0.001);
      this.camera.far = Math.max(distance * 100, 100);
      this.camera.updateProjectionMatrix();

      this.controls.target.set(0, 0, 0);
      this.controls.minDistance = distance * 0.35;
      this.controls.maxDistance = distance * 4;
      this.controls.update();
    }

    setupDivider() {
      if (!this.divider) return;

      const updateFromPointer = (event) => {
        const bounds = this.container.getBoundingClientRect();
        this.setSplit((event.clientX - bounds.left) / bounds.width);
      };

      this.divider.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.divider.setPointerCapture(event.pointerId);
        updateFromPointer(event);
      });
      this.divider.addEventListener('pointermove', (event) => {
        if (!this.divider.hasPointerCapture(event.pointerId)) return;
        updateFromPointer(event);
      });
      this.divider.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          this.setSplit(this.split - 0.025);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          this.setSplit(this.split + 0.025);
        } else if (event.key === 'Home') {
          event.preventDefault();
          this.setSplit(0);
        } else if (event.key === 'End') {
          event.preventDefault();
          this.setSplit(1);
        }
      });
    }

    setSplit(value) {
      this.split = Math.min(1, Math.max(0, value));
      const percent = `${(this.split * 100).toFixed(1)}%`;
      this.container.style.setProperty('--comparison-split', percent);
      if (this.divider) this.divider.setAttribute('aria-valuenow', Math.round(this.split * 100));
      this.render();
    }

    setupRotationToggle() {
      if (!this.rotationToggle) return;

      this.rotationToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        this.autoRotate = !this.autoRotate;
        this.updateRotationButton();
        if (this.autoRotate) this.startAnimation();
        else this.render();
      });
    }

    updateRotationButton() {
      if (!this.rotationToggle) return;
      this.rotationToggle.textContent = this.autoRotate ? 'Pause rotation' : 'Resume rotation';
      this.rotationToggle.setAttribute('aria-pressed', String(!this.autoRotate));
    }

    setupObservers() {
      if ('ResizeObserver' in window) {
        this.resizeObserver = new ResizeObserver(this.resize);
        this.resizeObserver.observe(this.container);
      } else {
        this.windowResizeHandler = this.resize;
        window.addEventListener('resize', this.windowResizeHandler, { passive: true });
      }

      if ('IntersectionObserver' in window) {
        this.visibilityObserver = new IntersectionObserver(
          ([entry]) => {
            this.isVisible = entry.isIntersecting;
            if (this.isVisible) this.startAnimation();
            else this.stopAnimation();
          },
          { rootMargin: '100px' }
        );
        this.visibilityObserver.observe(this.container);
      } else {
        this.isVisible = true;
      }

      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    handleVisibilityChange() {
      if (document.hidden) this.stopAnimation();
      else if (this.isVisible) this.startAnimation();
    }

    resize() {
      if (!this.renderer || this.isDisposed) return;
      const width = Math.max(this.container.clientWidth, 1);
      const height = Math.max(this.container.clientHeight, 1);
      this.renderWidth = width;
      this.renderHeight = height;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
      this.render();
    }

    startAnimation() {
      if (
        this.animationFrame !== null ||
        !this.isReady ||
        !this.isVisible ||
        document.hidden ||
        this.isDisposed
      ) {
        return;
      }

      this.lastFrameTime = performance.now();
      this.animationFrame = requestAnimationFrame(this.tick);
    }

    stopAnimation() {
      if (this.animationFrame === null) return;
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }

    tick(time) {
      this.animationFrame = null;
      if (this.isDisposed || !this.isVisible || document.hidden) return;

      const deltaFrames = Math.min((time - this.lastFrameTime) / (1000 / 60), 2);
      this.lastFrameTime = time;

      if (this.autoRotate) {
        const rotation = 0.005 * deltaFrames;
        const axis = this.options.kind === 'mesh' ? 'z' : 'y';
        if (this.beforeObject) this.beforeObject.rotation[axis] += rotation;
        if (this.afterObject) this.afterObject.rotation[axis] += rotation;
      }

      this.isTicking = true;
      const controlsChanged = this.controls.update();
      this.isTicking = false;
      this.render();

      if (this.autoRotate || controlsChanged) {
        this.animationFrame = requestAnimationFrame(this.tick);
      }
    }

    render() {
      if (!this.renderer || !this.camera || this.isDisposed) return;

      const width = this.renderWidth;
      const height = this.renderHeight;
      const splitWidth = Math.round(width * this.split);

      this.renderer.setScissorTest(true);
      this.renderer.setViewport(0, 0, width, height);

      this.renderer.setScissor(0, 0, splitWidth, height);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.beforeScene, this.camera);

      this.renderer.setScissor(splitWidth, 0, width - splitWidth, height);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.afterScene, this.camera);

      this.renderer.setScissorTest(false);
    }

    showSideError(side, message) {
      const status = document.createElement('span');
      status.className = `comparison-side-error is-${side}`;
      status.textContent = message;
      this.container.appendChild(status);
    }

    showError(message) {
      if (!this.loader) this.loader = this.container.querySelector('.comparison-loader');
      if (this.loader) {
        this.loader.hidden = false;
        this.loader.textContent = message;
      }
    }

    dispose() {
      if (this.isDisposed) return;
      this.isDisposed = true;
      this.abortController.abort();
      this.stopAnimation();

      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
      if (this.resizeObserver) this.resizeObserver.disconnect();
      if (this.visibilityObserver) this.visibilityObserver.disconnect();
      if (this.windowResizeHandler) {
        window.removeEventListener('resize', this.windowResizeHandler);
      }
      if (this.controls) this.controls.dispose();

      disposeObject(this.beforeObject);
      disposeObject(this.afterObject);

      if (this.renderer) {
        this.renderer.renderLists.dispose();
        this.renderer.dispose();
        this.renderer.forceContextLoss();
        this.renderer.domElement.remove();
      }
    }
  }

  function lazyViewer(container, options) {
    let viewer = null;
    let observer = null;
    let cancelled = false;

    const initialize = async () => {
      if (viewer || cancelled || !document.body.contains(container)) return;
      try {
        await ensureThreeRuntime();
        if (!cancelled && document.body.contains(container)) {
          viewer = new ThreeComparisonViewer(container, options);
        }
      } catch (error) {
        const loader = container.querySelector('.comparison-loader');
        if (loader) loader.textContent = 'The 3D viewer could not be loaded.';
      }
    };

    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting) return;
          observer.disconnect();
          observer = null;
          initialize();
        },
        { rootMargin: '250px' }
      );
      observer.observe(container);
    } else {
      initialize();
    }

    return () => {
      cancelled = true;
      if (observer) observer.disconnect();
      if (viewer) viewer.dispose();
    };
  }

  function pageNumbers(current, total) {
    const numbers = new Set([1, total, current - 1, current, current + 1]);
    if (current <= 4) [2, 3, 4, 5].forEach((page) => numbers.add(page));
    if (current >= total - 3) {
      [total - 4, total - 3, total - 2, total - 1].forEach((page) => numbers.add(page));
    }
    return [...numbers].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  }

  function renderPagination(host, current, total, onChange) {
    host.replaceChildren();
    const nav = document.createElement('nav');
    nav.className = 'pagination is-centered mt-5 mb-5 viewer-pagination';
    nav.setAttribute('role', 'navigation');
    nav.setAttribute('aria-label', 'Results pagination');

    const makeStepLink = (className, label, target, disabled) => {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = className;
      link.textContent = label;
      if (disabled) {
        link.classList.add('is-disabled');
        link.setAttribute('aria-disabled', 'true');
        link.disabled = true;
        link.tabIndex = -1;
      } else {
        link.addEventListener('click', () => onChange(target));
      }
      return link;
    };

    nav.appendChild(makeStepLink('pagination-previous', 'Previous', current - 1, current === 1));
    nav.appendChild(makeStepLink('pagination-next', 'Next', current + 1, current === total));

    const list = document.createElement('ul');
    list.className = 'pagination-list';
    const numbers = pageNumbers(current, total);

    numbers.forEach((page, index) => {
      if (index > 0 && page - numbers[index - 1] > 1) {
        const ellipsisItem = document.createElement('li');
        const ellipsis = document.createElement('span');
        ellipsis.className = 'pagination-ellipsis';
        ellipsis.innerHTML = '&hellip;';
        ellipsisItem.appendChild(ellipsis);
        list.appendChild(ellipsisItem);
      }

      const item = document.createElement('li');
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'pagination-link';
      link.textContent = page;
      link.setAttribute('aria-label', page === current ? `Page ${page}` : `Go to page ${page}`);
      if (page === current) {
        link.classList.add('is-current');
        link.setAttribute('aria-current', 'page');
      } else {
        link.addEventListener('click', () => onChange(page));
      }
      item.appendChild(link);
      list.appendChild(item);
    });

    nav.appendChild(list);
    host.appendChild(nav);
  }

  function comparisonCard(config, sampleNumber) {
    const column = document.createElement('div');
    column.className = 'column is-4';

    const container = document.createElement('div');
    container.className = 'threejs-comparison';
    container.id = `${config.idPrefix}-${sampleNumber}`;
    container.innerHTML = `
      <span class="comparison-label is-before">${config.beforeLabel}</span>
      <span class="comparison-label is-after">${config.afterLabel}</span>
      <button
        class="comparison-divider"
        type="button"
        role="slider"
        aria-label="Reveal more or less of each 3D result"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="50"
      >
        <span class="comparison-divider-handle" aria-hidden="true">&#8596;</span>
      </button>
      <button class="comparison-rotation-toggle" type="button">Pause rotation</button>
      <div class="comparison-loader">
        <div class="spinner"></div>
        <span>Loading comparison...</span>
      </div>
    `;

    column.append(container);
    return { column, container };
  }

  function setupPaged3DResults(config) {
    const pageHost = document.getElementById(config.pageHostId);
    const paginationHost = document.getElementById(config.paginationHostId);
    if (!pageHost || !paginationHost) return;

    let currentPage = 1;
    let disposeViewers = [];

    const showPage = (page) => {
      currentPage = Math.min(config.totalPages, Math.max(1, page));
      disposeViewers.forEach((dispose) => dispose());
      disposeViewers = [];
      pageHost.replaceChildren();

      const pageElement = document.createElement('div');
      pageElement.className = 'columns is-multiline viewer-page';
      const firstSample = config.startSample + (currentPage - 1) * config.samplesPerPage;

      for (let offset = 0; offset < config.samplesPerPage; offset += 1) {
        const sample = firstSample + offset;
        if (sample > config.endSample) break;

        const { column, container } = comparisonCard(config, sample);
        pageElement.appendChild(column);
        disposeViewers.push(
          lazyViewer(container, {
            kind: config.kind,
            beforeLabel: config.beforeLabel,
            afterLabel: config.afterLabel,
            beforeUrl: config.beforeUrl(sample),
            afterUrl: config.afterUrl(sample)
          })
        );
      }

      pageHost.appendChild(pageElement);
      renderPagination(paginationHost, currentPage, config.totalPages, showPage);
    };

    showPage(1);
  }

  function setupRadianceFieldResults() {
    const host = document.querySelector('.rf-pagination-container');
    if (!host) return;

    const totalPages = 10;
    const samplesPerPage = 10;
    host.innerHTML = '<p class="has-text-centered">Loading comparisons...</p>';

    const showPage = (page) => {
      const currentPage = Math.min(totalPages, Math.max(1, page));
      host.replaceChildren();
      const pageElement = document.createElement('div');
      pageElement.className = 'rf-page';
      const firstSample = (currentPage - 1) * samplesPerPage + 1;

      for (let row = 0; row < 2; row += 1) {
        const grid = document.createElement('div');
        grid.className = 'grid-container';

        for (let offset = 0; offset < 5; offset += 1) {
          const sample = firstSample + row * 5 + offset;
          const padded = String(sample).padStart(6, '0');
          const comparison = document.createElement('div');
          comparison.style.position = 'relative';
          comparison.innerHTML = `
            <img-comparison-slider aria-label="Radiance field sample ${sample} comparison">
              <img
                slot="first"
                src="${RESULTS_ROOT}/rf_gt/${padded}/view_007.png"
                alt="Ground-truth radiance field sample ${sample}"
                loading="lazy"
                decoding="async"
              />
              <img
                slot="second"
                src="${RESULTS_ROOT}/gen_rf/${padded}/view_007.png"
                alt="Squeeze3D radiance field reconstruction ${sample}"
                loading="lazy"
                decoding="async"
              />
              <div slot="first-label" class="image-label label-left">Ground Truth</div>
              <div slot="second-label" class="image-label label-right">Squeeze3D</div>
            </img-comparison-slider>
          `;
          grid.appendChild(comparison);
        }
        pageElement.appendChild(grid);
      }

      const pagination = document.createElement('div');
      host.append(pageElement, pagination);
      renderPagination(pagination, currentPage, totalPages, showPage);
    };

    const initialize = async () => {
      try {
        await ensureImageComparisonRuntime();
        showPage(1);
      } catch (error) {
        host.innerHTML = '<p class="has-text-centered">The radiance-field comparisons could not be loaded.</p>';
      }
    };

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting) return;
          observer.disconnect();
          initialize();
        },
        { rootMargin: '500px' }
      );
      observer.observe(host);
    } else {
      initialize();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupPaged3DResults({
      kind: 'mesh',
      pageHostId: 'model-pages-container',
      paginationHostId: 'model-pagination',
      idPrefix: 'mesh-comparison',
      startSample: 50,
      endSample: 109,
      samplesPerPage: 3,
      totalPages: 20,
      beforeLabel: 'Ground Truth',
      afterLabel: 'Squeeze3D',
      beforeUrl: (sample) => `${RESULTS_ROOT}/gt_meshes/${sample}/`,
      afterUrl: (sample) => `${RESULTS_ROOT}/gen_meshes/${sample}/`
    });

    setupRadianceFieldResults();

    setupPaged3DResults({
      kind: 'point-cloud',
      pageHostId: 'pc-pages-container',
      paginationHostId: 'pc-pagination',
      idPrefix: 'point-cloud-comparison',
      startSample: 1,
      endSample: 60,
      samplesPerPage: 3,
      totalPages: 20,
      beforeLabel: 'Ground Truth',
      afterLabel: 'Squeeze3D',
      beforeUrl: (sample) => `${RESULTS_ROOT}/gt_pc/${sample}.ply`,
      afterUrl: (sample) => `${RESULTS_ROOT}/gen_pc/${sample}.ply`
    });
  });
})();
