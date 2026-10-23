import type { Scene, SceneElement, MotionState } from '../types';

export const TRACK_DEFAULTS: MotionState;
export const TRACK_PROPS: string[];
export function escapeJsxText(text: string): string;
export function classSuffix(id: string): string;
export function sampleTrack(
  track: { offset: number; value: number }[] | undefined,
  offset: number,
  fallback: number
): number;
export function collectOffsets(element: SceneElement): number[];
export function sampleElementAt(element: SceneElement, offset: number): MotionState;
export function anchorTranslate(anchor: string): { x: number; y: number };
export function generatePageJsx(scene: Scene): string;
export function generateAnimationsCss(scene: Scene): string;
