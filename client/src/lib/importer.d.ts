import type { ElementType, SceneElement } from '../types';

/** Measured style snapshot taken from getComputedStyle in the import iframe. */
export interface ImportCandidateStyle {
  color?: string;
  backgroundColor?: string;
  fontSizePx?: number;
  fontWeight?: string | number;
  fontStyle?: string;
  textAlign?: string;
  borderRadius?: string;
  opacity?: number;
  fontFamily?: string;
  lineHeightPx?: number;
}

/** One meaningful DOM node measured in the hidden import iframe. */
export interface ImportCandidate {
  tag: string;
  text: string;
  src?: string;
  /** True for background-bearing containers (kept as a card behind children). */
  container?: boolean;
  hasBgImage?: boolean;
  rect: { left: number; top: number; width: number; height: number };
  style: ImportCandidateStyle;
}

export interface ImportPageInfo {
  width: number;
  height: number;
  /** fontScale = editor stage width / iframe render width (keeps text proportional). */
  fontScale?: number;
}

/** A converted element: feed into createElement(spec.type, spec.fields). */
export interface ImportSpec {
  type: ElementType;
  fields: Partial<SceneElement>;
}

export interface ImportConversion {
  specs: ImportSpec[];
  skipped: number;
  truncated: boolean;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export const IMPORT_CAP: number;
export function colorToHex(cssColor: string): string | null;
export function styleObjectToCss(body: string): string;
export function jsxToHtml(input: string): string;
export function detectFormat(src: string, filename?: string): 'html' | 'jsx';
export function classifyCandidate(c: ImportCandidate): ElementType | null;
export function parseRadiusPx(borderRadius: string, widthPx: number): number | null;
export function mapCandidate(
  c: ImportCandidate,
  page: ImportPageInfo
): { spec: ImportSpec | null; reason: string | null };
export function candidatesToSpecs(candidates: ImportCandidate[], page: ImportPageInfo): ImportConversion;
export function pickEntryFile(names: string[]): string | null;
export function resolveAssetSrc(src: string, assets: Record<string, string>): string;
export function readZipEntries(input: ArrayBuffer | Uint8Array): Promise<ZipEntry[]>;
