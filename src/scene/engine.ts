// A small PlayCanvas app for the table scene and the /me portraits. Only the
// systems and handlers a GLB scene needs are registered, so the bundler can drop
// the rest of the engine (physics, UI, sound, particles, WebGPU and so on).
import {
  AnimationHandler,
  AnimClipHandler,
  AnimComponentSystem,
  AnimStateGraphHandler,
  AppBase,
  AppOptions,
  BinaryHandler,
  CameraComponentSystem,
  type ContainerResource,
  ContainerHandler,
  createGraphicsDevice,
  DEVICETYPE_WEBGL2,
  LightComponentSystem,
  MaterialHandler,
  RenderComponentSystem,
  RenderHandler,
  TextureHandler,
} from "playcanvas";

export type Engine = {
  app: AppBase;
  canvas: HTMLCanvasElement;
  load(url: string): Promise<ContainerResource>;
  destroy(): void;
};

export async function createEngine(canvas: HTMLCanvasElement, opts: { antialias?: boolean; alpha?: boolean; maxPixelRatio?: number } = {}): Promise<Engine> {
  const device = await createGraphicsDevice(canvas, {
    deviceTypes: [DEVICETYPE_WEBGL2],
    antialias: opts.antialias ?? true,
    alpha: opts.alpha ?? false,
  });
  device.maxPixelRatio = opts.maxPixelRatio ?? Math.min(window.devicePixelRatio || 1, 2);

  const app = new AppBase(canvas);
  const options = new AppOptions();
  options.graphicsDevice = device;
  options.componentSystems = [RenderComponentSystem, CameraComponentSystem, LightComponentSystem, AnimComponentSystem];
  options.resourceHandlers = [
    RenderHandler,
    MaterialHandler,
    TextureHandler,
    BinaryHandler,
    AnimationHandler,
    AnimClipHandler,
    AnimStateGraphHandler,
    ContainerHandler,
  ];
  app.init(options);

  // Each GLB is fetched and parsed once; everything standing on it is an instance.
  const loaded = new Map<string, Promise<ContainerResource>>();
  const load = (url: string) => {
    let p = loaded.get(url);
    if (!p) {
      p = new Promise<ContainerResource>((resolve, reject) => {
        app.assets.loadFromUrl(url, "container", (err, asset) => {
          if (err || !asset?.resource) reject(new Error(`Could not load ${url}: ${err ?? "empty"}`));
          else resolve(asset.resource as ContainerResource);
        });
      });
      loaded.set(url, p);
      p.catch(() => loaded.delete(url));
    }
    return p;
  };

  return {
    app,
    canvas,
    load,
    destroy() {
      app.destroy();
    },
  };
}
