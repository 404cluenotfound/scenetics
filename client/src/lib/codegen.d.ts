import type { Scene, SceneElement, MotionState } from '../types';

/** Merged motion state: raw tracks + baseRotate + flip (scaleX/scaleY). */
export interface MergedMotion extends MotionState {
  scaleX: number;
  scaleY: number;
}

export const TRACK_DEFAULTS: MotionState;
export const TRACK_PROPS: string[];
export const SHADOWS: Record<string, string>;
export function escapeJsxText(text: string): string;
export function classSuffix(id: string): string;
export function placeholderImageSrc(element: SceneElement): string;
export function sampleTrack(
  track: { offset: number; value: number }[] | undefined,
  offset: number,
  fallback: number
): number;
export function collectOffsets(element: SceneElement): number[];
/** Raw keyframe-track sampling (Motion panel space — no base offsets). */
export function sampleTracksAt(element: SceneElement, offset: number): MotionState;
/** Merged sampling used by BOTH the editor preview and the exporter. */
export function sampleElementAt(element: SceneElement, offset: number): MergedMotion;
export function anchorTranslate(anchor: string): { x: number; y: number };
export function generatePageJsx(scene: Scene): string;
export function generateAnimationsCss(scene: Scene): string;
