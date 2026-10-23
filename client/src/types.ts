export type ElementType = 'heading' | 'text' | 'button' | 'card' | 'image';

export type Anchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface Keyframe {
  offset: number; // scroll % (0–100)
  value: number;
}

export type TrackProp = 'translateX' | 'translateY' | 'scale' | 'rotate' | 'opacity';

export type Tracks = Partial<Record<TrackProp, Keyframe[]>>;

export interface MotionState {
  translateX: number;
  translateY: number;
  scale: number;
  rotate: number;
  opacity: number;
}

export interface SceneElement {
  id: string;
  type: ElementType;
  text: string;
  color: string;
  bg: string;
  fontSize: number; // px, editor-scale; exported as rem
  radius: number; // px border radius
  opacity: number; // base opacity (used when the element has no keyframes)
  widthPercent: number; // % of stage width
  anchor: Anchor;
  xPercent: number; // anchor point position, % of stage width
  yPercent: number; // anchor point position, % of stage height
  tracks: Tracks;
}

export interface Scene {
  id: string;
  name: string;
  scrollLengthVh: number;
  elements: SceneElement[];
}
