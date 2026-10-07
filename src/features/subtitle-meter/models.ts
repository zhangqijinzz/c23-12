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
export type SaveStatus = "idle" | "saving" | "saved" | "error";
export interface SaveError {
  /** 这次失败对应的修改序号（每次提交递增） */
  revision: number;
  /** 失败那次改动的说明，用于把错误对应到具体一次编辑 */
  action: string;
  message: string;
}
export interface MeterState {
  phase: "empty" | "importing" | "ready" | "editing" | "exporting" | "error";
  project: SubtitleProject | null;
  issues: SubtitleIssue[];
  selectedId: string | null;
  notice: string;
  zoom: number;
  /** 自动保存的独立状态，不再与 phase（导入/导出）混用 */
  saveStatus: SaveStatus;
  /** 尚未被一次成功保存消除的失败；保留到重试成功为止，不会被后续编辑盖掉 */
  saveError: SaveError | null;
}
export const emptyState = (): MeterState => ({
  phase: "empty",
  project: null,
  issues: [],
  selectedId: null,
  notice: "",
  zoom: 1,
  saveStatus: "idle",
  saveError: null,
});
