export type Format = "srt" | "vtt";
export interface SubtitleCue {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}
export type IssueType =
  | "overlap"
  | "too-short"
  | "too-fast"
  | "too-long"
  | "empty"
  | "invalid-time";
export interface SubtitleIssue {
  id: string;
  cueId: string;
  type: IssueType;
  severity: "info" | "warning" | "error";
  message: string;
}
export interface SubtitleProject {
  id: string;
  name: string;
  format: Format;
  cues: SubtitleCue[];
  updatedAt: number;
  versions: Array<{
    id: string;
    label: string;
    savedAt: number;
    cues: SubtitleCue[];
  }>;
}
export interface MeterState {
  phase: "empty" | "importing" | "ready" | "error";
  project: SubtitleProject | null;
  issues: SubtitleIssue[];
  selectedId: string | null;
  notice: string;
  zoom: number;
  /** 本地自动保存状态：与 phase 分离，编辑/导出互不干扰 */
  saveState: "idle" | "saving" | "saved" | "error";
  /** 最近一次保存失败对应的改动序号（第几次编辑） */
  saveErrorRevision: number | null;
  /** 正在保存的改动序号 */
  savingRevision: number | null;
  /** 导出进行中标记，独立于保存与页面阶段 */
  exporting: boolean;
}
export const emptyState = (): MeterState => ({
  phase: "empty",
  project: null,
  issues: [],
  selectedId: null,
  notice: "",
  zoom: 1,
  saveState: "idle",
  saveErrorRevision: null,
  savingRevision: null,
  exporting: false,
});
