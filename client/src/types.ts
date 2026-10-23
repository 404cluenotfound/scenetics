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

export type TextAlign = 'left' | 'center' | 'right';
export type ShadowPreset = 'none' | 'sm' | 'md' | 'lg';

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
  /** % of stage height; null = auto (content height; images keep 4/3 aspect). */
  heightPercent: number | null;
  anchor: Anchor;
  xPercent: number; // anchor point position, % of stage width
  yPercent: number; // anchor point position, % of stage height
  tracks: Tracks;
  /* ---- v0.2 editor tools ---- */
  /** Base rotation in degrees. Merged INTO the rotate keyframe track on
      export (constraint 3) and preview, never a competing transform. */
  baseRotate: number;
  /** Flip flags — merged into the scale keyframe track / standalone scale. */
  flipH: boolean;
  flipV: boolean;
  /** Image crop (images only): object-position % and inner-image zoom. */
  cropX: number;
  cropY: number;
  cropZoom: number;
  /** Optional image URL; empty = generated placeholder. */
  imageSrc: string;
  locked: boolean;
  /** Elements sharing a groupId select/move together (export stays flat). */
  groupId: string | null;
  /* Text tools */
  fontFamily: string; // 'inherit' or a font-family name string
  bold: boolean;
  italic: boolean;
  underline: boolean;
  textAlign: TextAlign;
  lineHeight: number; // unitless multiplier
  letterSpacing: number; // px
  /* Style tools */
  borderWidth: number; // px, 0 = no border
  borderColor: string;
  shadow: ShadowPreset;
}

export interface Scene {
  id: string;
  name: string;
  scrollLengthVh: number;
  elements: SceneElement[];
}
