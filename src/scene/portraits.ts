// Character portraits for /me: the real 3D model, drawn once into a small
// canvas (one shared offscreen engine, one render per portrait, no running
// loop), so the editor shows what the table will show. Static images: nothing
// here animates. The caller falls back to the drawn badge on any failure.
import { Color, Entity } from "playcanvas";
import type { Avatar } from "../lib/avatar.ts";
import { Character, Kit } from "./character.ts";
import { createEngine } from "./engine.ts";

export type Portraits = {
  // `bare` leaves out hat, eyewear and aid (the character chips). `isStale` is
  // checked just before the render starts; if it returns true the render is
  // dropped and the promise rejects with StaleRender (not a failure).
  render(look: Avatar, opts?: { bare?: boolean; isStale?: () => boolean }): Promise<HTMLCanvasElement>;
  destroy(): void;
};

const SIZE = 192;

export class StaleRender extends Error {
  override name = "StaleRender";
}

export async function createPortraits(opts: { onContextLost?: () => void } = {}): Promise<Portraits> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const engine = await createEngine(canvas, { alpha: true, antialias: true, maxPixelRatio: 1 });
  const { app } = engine;
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    opts.onContextLost?.();
  });
  app.autoRender = false;
  const kit = new Kit(engine);

  const key = new Entity();
  key.addComponent("light", { type: "directional", color: new Color(1, 0.95, 0.88), intensity: 1.2 });
  key.setLocalEulerAngles(35, 25, 0);
  app.root.addChild(key);
  app.scene.ambientLight = new Color(0.62, 0.6, 0.6);
  const cam = new Entity();
  cam.addComponent("camera", { fov: 21, nearClip: 0.2, farClip: 20, clearColor: new Color(0, 0, 0, 0) });
  cam.setLocalPosition(0, 0.62, 2.6);
  cam.lookAt(0, 0.5, 0);
  app.root.addChild(cam);
  app.start();

  let queue: Promise<unknown> = Promise.resolve();
  const one = async (look: Avatar, bare: boolean): Promise<HTMLCanvasElement> => {
    const shown: Avatar = bare ? { ...look, hat: "none", accessory: "none", aid: "none", mood: "chill" } : look;
    const ch = await Character.create(kit, shown, { seated: false });
    ch.root.setLocalEulerAngles(0, -18, 0);
    app.root.addChild(ch.root);
    ch.play("idle");
    ch.setSpeed(0);
    app.update(0.05);
    app.update(0.05);
    app.render();
    const out = document.createElement("canvas");
    out.width = out.height = SIZE;
    out.getContext("2d")!.drawImage(canvas, 0, 0);
    ch.destroy();
    return out;
  };
  return {
    render(look, o = {}) {
      const run = queue.then(() => {
        if (o.isStale?.()) throw new StaleRender();
        return one(look, !!o.bare);
      });
      queue = run.catch(() => {});
      return run;
    },
    destroy() {
      engine.destroy();
    },
  };
}
