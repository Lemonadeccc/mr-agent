"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./studio-home.module.css";

const CELL_SIZE = 20;
const RULER_LEFT_GUTTER = 30;
const RULER_TOP_GUTTER = 20;

interface PixelCluster {
  id: string;
  left: number;
  top: number;
}

function getColumnLabel(index: number): string {
  let label = "";
  let value = index + 1;

  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }

  return label;
}

function createPixelClusters(): PixelCluster[] {
  const clusters: PixelCluster[] = [];
  const strokes = 8;
  const maxCols = Math.ceil(window.innerWidth / CELL_SIZE);
  const maxRows = Math.ceil(window.innerHeight / CELL_SIZE);

  for (let stroke = 0; stroke < strokes; stroke += 1) {
    const startX = Math.floor(Math.random() * maxCols);
    const startY = Math.floor(Math.random() * maxRows);
    const length = 20 + Math.floor(Math.random() * 50);
    const dx = Math.random() > 0.5 ? 1 : -1;
    const dy = Math.random() > 0.5 ? 1 : 0;

    for (let index = 0; index < length; index += 1) {
      const thickness = Math.floor(Math.random() * 3) + 1;
      for (let layer = 0; layer < thickness; layer += 1) {
        if (Math.random() > 0.2) {
          clusters.push({
            id: `${stroke}-${index}-${layer}`,
            left: (startX + index * dx) * CELL_SIZE,
            top: (startY + index * dy + layer) * CELL_SIZE,
          });
        }
      }
    }
  }

  return clusters;
}

export function InteractiveGrid() {
  const [coordsLabel, setCoordsLabel] = useState("X: A | Y: 1");
  const [cursorVisible, setCursorVisible] = useState(false);
  const [cursorPosition, setCursorPosition] = useState({ x: 0, y: 0 });
  const [rulerXItems, setRulerXItems] = useState<string[]>([]);
  const [rulerYItems, setRulerYItems] = useState<number[]>([]);
  const [pixelClusters, setPixelClusters] = useState<PixelCluster[]>([]);

  const cursorVisibleRef = useRef(false);
  const lastCellRef = useRef<{ x: number; y: number } | null>(null);
  const pendingMouseRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const mouseFrameRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const pixelTimerRef = useRef<number | null>(null);

  const updateRulers = useCallback(() => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const cols = Math.ceil(width / CELL_SIZE);
    const rows = Math.ceil(height / CELL_SIZE);

    setRulerXItems(Array.from({ length: cols }, (_, index) => getColumnLabel(index)));
    setRulerYItems(Array.from({ length: rows }, (_, index) => index + 1));
  }, []);

  const schedulePixelRegeneration = useCallback(() => {
    if (pixelTimerRef.current) {
      window.clearTimeout(pixelTimerRef.current);
    }
    pixelTimerRef.current = window.setTimeout(() => {
      setPixelClusters(createPixelClusters());
      pixelTimerRef.current = null;
    }, 120);
  }, []);

  const flushMouseUpdate = useCallback(() => {
    mouseFrameRef.current = null;
    const nextPoint = pendingMouseRef.current;
    if (!nextPoint) {
      return;
    }

    const x = Math.floor((nextPoint.clientX - RULER_LEFT_GUTTER) / CELL_SIZE);
    const y = Math.floor((nextPoint.clientY - RULER_TOP_GUTTER) / CELL_SIZE);

    if (nextPoint.clientX <= RULER_LEFT_GUTTER || nextPoint.clientY <= RULER_TOP_GUTTER) {
      if (cursorVisibleRef.current) {
        setCursorVisible(false);
        cursorVisibleRef.current = false;
      }
      return;
    }

    const lastCell = lastCellRef.current;
    const changedCell = !lastCell || lastCell.x !== x || lastCell.y !== y;

    if (!cursorVisibleRef.current) {
      setCursorVisible(true);
      cursorVisibleRef.current = true;
    }

    if (!changedCell) {
      return;
    }

    lastCellRef.current = { x, y };
    setCursorPosition({
      x: x * CELL_SIZE + RULER_LEFT_GUTTER,
      y: y * CELL_SIZE + RULER_TOP_GUTTER,
    });
    setCoordsLabel(`X: ${getColumnLabel(x)} | Y: ${y + 1}`);
  }, []);

  useEffect(() => {
    const initFrame = window.requestAnimationFrame(() => {
      updateRulers();
      setPixelClusters(createPixelClusters());
    });

    const handleMouseMove = (event: MouseEvent) => {
      pendingMouseRef.current = { clientX: event.clientX, clientY: event.clientY };
      if (mouseFrameRef.current === null) {
        mouseFrameRef.current = window.requestAnimationFrame(flushMouseUpdate);
      }
    };

    const handleResize = () => {
      if (resizeFrameRef.current !== null) {
        return;
      }
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        updateRulers();
        schedulePixelRegeneration();
      });
    };

    document.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("resize", handleResize);

    return () => {
      window.cancelAnimationFrame(initFrame);
      document.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("resize", handleResize);
      if (mouseFrameRef.current !== null) {
        window.cancelAnimationFrame(mouseFrameRef.current);
      }
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
      if (pixelTimerRef.current) {
        window.clearTimeout(pixelTimerRef.current);
      }
    };
  }, [flushMouseUpdate, schedulePixelRegeneration, updateRulers]);

  return (
    <>
      <div className={styles.cornerPiece} />

      <div className={styles.rulerX}>
        {rulerXItems.map((label, index) => (
          <span key={`${label}-${index}`} className={styles.rulerXCell}>
            {label}
          </span>
        ))}
      </div>

      <div className={styles.rulerY}>
        {rulerYItems.map((label, index) => (
          <span key={`${label}-${index}`} className={styles.rulerYCell}>
            {label}
          </span>
        ))}
      </div>

      <div className={styles.gridLayer} aria-hidden />

      {cursorVisible ? (
        <div
          className={styles.cursorBox}
          style={{ transform: `translate(${cursorPosition.x}px, ${cursorPosition.y}px)` }}
        />
      ) : null}

      <div className={styles.coordsDisplay}>{coordsLabel}</div>

      <div className={styles.pixelLayer} aria-hidden>
        {pixelClusters.map((cluster) => (
          <span
            key={cluster.id}
            className={styles.pixelCluster}
            style={{ left: cluster.left, top: cluster.top }}
          />
        ))}
      </div>
    </>
  );
}
