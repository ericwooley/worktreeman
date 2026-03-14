import { useEffect, useRef } from "react";

const PI = Math.PI;
const HALF_PI = 0.5 * PI;
const TAU = 2 * PI;
const TO_RAD = PI / 180;

const PIPE_COUNT = 30;
const PIPE_PROP_COUNT = 8;
const PIPE_PROPS_LENGTH = PIPE_COUNT * PIPE_PROP_COUNT;
const TURN_COUNT = 8;
const TURN_AMOUNT = (360 / TURN_COUNT) * TO_RAD;
const TURN_CHANCE_RANGE = 58;
const BASE_SPEED = 0.5;
const RANGE_SPEED = 1;
const BASE_TTL = 100;
const RANGE_TTL = 300;
const BASE_WIDTH = 2;
const RANGE_WIDTH = 4;

export interface AmbientPalette {
  backgroundColor: string;
  baseHue: number;
  rangeHue: number;
  blur: number;
  overlayClassName?: string;
}

export const appAmbientPalette: AmbientPalette = {
  backgroundColor: "hsla(42, 32%, 91%, 1)",
  baseHue: 18,
  rangeHue: 42,
  blur: 14,
  overlayClassName: "bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.24),transparent_44%),linear-gradient(180deg,rgba(255,255,255,0.16),rgba(255,255,255,0.03)_32%,rgba(255,255,255,0.14))]",
};

export const docsAmbientPalette: AmbientPalette = {
  backgroundColor: "hsla(130, 42%, 3%, 1)",
  baseHue: 120,
  rangeHue: 36,
  blur: 16,
  overlayClassName:
    "bg-[radial-gradient(circle_at_top,rgba(74,255,122,0.12),transparent_42%),linear-gradient(180deg,rgba(0,0,0,0.18),rgba(0,0,0,0.02)_28%,rgba(0,0,0,0.3))]",
};

export function AmbientCanvasBackground({ palette }: { palette: AmbientPalette }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const contextVisible = canvas.getContext("2d");
    if (!contextVisible) {
      return;
    }

    const offscreenCanvas = document.createElement("canvas");
    const contextOffscreen = offscreenCanvas.getContext("2d");
    if (!contextOffscreen) {
      return;
    }

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let centerY = 0;
    let tick = 0;
    let animationFrame = 0;
    let pipeProps = new Float32Array(PIPE_PROPS_LENGTH);

    const rand = (limit: number) => limit * Math.random();
    const round = (value: number) => Math.round(value);
    const fadeInOut = (time: number, max: number) => {
      const half = 0.5 * max;
      return Math.abs(((time + half) % max) - half) / half;
    };

    const setDisplaySize = (target: HTMLCanvasElement) => {
      target.style.width = "100%";
      target.style.height = "100%";
    };

    const initPipe = (index: number) => {
      const x = rand(width);
      const y = centerY;
      const direction = round(rand(1)) ? HALF_PI : TAU - HALF_PI;
      const speed = BASE_SPEED + rand(RANGE_SPEED);
      const life = 0;
      const ttl = BASE_TTL + rand(RANGE_TTL);
      const lineWidth = BASE_WIDTH + rand(RANGE_WIDTH);
      const hue = palette.baseHue + rand(palette.rangeHue);

      pipeProps.set([x, y, direction, speed, life, ttl, lineWidth, hue], index);
    };

    const initPipes = () => {
      pipeProps = new Float32Array(PIPE_PROPS_LENGTH);

      for (let index = 0; index < PIPE_PROPS_LENGTH; index += PIPE_PROP_COUNT) {
        initPipe(index);
      }
    };

    const drawPipe = (x: number, y: number, life: number, ttl: number, lineWidth: number, hue: number) => {
      contextOffscreen.save();
      contextOffscreen.strokeStyle = `hsla(${hue}, 75%, 50%, ${fadeInOut(life, ttl) * 0.125})`;
      contextOffscreen.lineWidth = lineWidth;
      contextOffscreen.beginPath();
      contextOffscreen.arc(x, y, lineWidth, 0, TAU);
      contextOffscreen.stroke();
      contextOffscreen.closePath();
      contextOffscreen.restore();
    };

    const updatePipe = (index: number) => {
      const directionIndex = index + 2;
      const speedIndex = index + 3;
      const lifeIndex = index + 4;
      const ttlIndex = index + 5;
      const lineWidthIndex = index + 6;
      const hueIndex = index + 7;

      let x = pipeProps[index];
      let y = pipeProps[index + 1];
      let direction = pipeProps[directionIndex];
      const speed = pipeProps[speedIndex];
      let life = pipeProps[lifeIndex];
      const ttl = pipeProps[ttlIndex];
      const lineWidth = pipeProps[lineWidthIndex];
      const hue = pipeProps[hueIndex];

      drawPipe(x, y, life, ttl, lineWidth, hue);

      life += 1;
      x += Math.cos(direction) * speed;
      y += Math.sin(direction) * speed;

      const shouldTurn = !(tick % round(rand(TURN_CHANCE_RANGE))) && (!(round(x) % 6) || !(round(y) % 6));
      const turnBias = round(rand(1)) ? -1 : 1;
      direction += shouldTurn ? TURN_AMOUNT * turnBias : 0;

      if (x > width) {
        x = 0;
      } else if (x < 0) {
        x = width;
      }

      if (y > height) {
        y = 0;
      } else if (y < 0) {
        y = height;
      }

      pipeProps[index] = x;
      pipeProps[index + 1] = y;
      pipeProps[directionIndex] = direction;
      pipeProps[lifeIndex] = life;

      if (life > ttl) {
        initPipe(index);
      }
    };

    const updatePipes = () => {
      tick += 1;

      for (let index = 0; index < PIPE_PROPS_LENGTH; index += PIPE_PROP_COUNT) {
        updatePipe(index);
      }
    };

    const render = () => {
      contextVisible.save();
      contextVisible.fillStyle = palette.backgroundColor;
      contextVisible.fillRect(0, 0, width, height);
      contextVisible.restore();

      contextVisible.save();
      contextVisible.filter = `blur(${palette.blur}px)`;
      contextVisible.drawImage(offscreenCanvas, 0, 0, width, height);
      contextVisible.restore();

      contextVisible.save();
      contextVisible.drawImage(offscreenCanvas, 0, 0, width, height);
      contextVisible.restore();
    };

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.floor(bounds.width));
      const nextHeight = Math.max(1, Math.floor(bounds.height));

      if (nextWidth === width && nextHeight === height) {
        return;
      }

      const visibleBuffer = document.createElement("canvas");
      visibleBuffer.width = contextVisible.canvas.width;
      visibleBuffer.height = contextVisible.canvas.height;
      const visibleBufferContext = visibleBuffer.getContext("2d");
      visibleBufferContext?.drawImage(canvas, 0, 0);

      width = nextWidth;
      height = nextHeight;
      centerY = 0.5 * height;

      offscreenCanvas.width = width;
      offscreenCanvas.height = height;
      canvas.width = width;
      canvas.height = height;

      setDisplaySize(offscreenCanvas);
      setDisplaySize(canvas);

      if (visibleBuffer.width > 0 && visibleBuffer.height > 0) {
        contextOffscreen.drawImage(visibleBuffer, 0, 0, width, height);
        contextVisible.drawImage(visibleBuffer, 0, 0, width, height);
      }

      if (!tick) {
        initPipes();
      }

      render();
    };

    const draw = () => {
      updatePipes();
      render();

      if (!reduceMotion) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    };

    resize();

    if (reduceMotion) {
      updatePipes();
      render();
    } else {
      animationFrame = window.requestAnimationFrame(draw);
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    window.addEventListener("resize", resize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(animationFrame);
    };
  }, [palette]);

  return (
    <div className="pointer-events-none fixed inset-0">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full opacity-[0.96]" aria-hidden="true" />
      {palette.overlayClassName ? <div className={`absolute inset-0 opacity-[0.42] ${palette.overlayClassName}`} /> : null}
    </div>
  );
}
