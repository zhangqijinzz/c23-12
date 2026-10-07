import type { Format, SubtitleCue } from "../models";
import { formatSubtitles } from "../formatters/subtitleFormatter";
export function downloadSubtitles(
  name: string,
  cues: SubtitleCue[],
  format: Format,
  /** 调用方在导出开始时格式化好的内容快照，避免导出与编辑并发时内容被中途改写 */
  rendered: string = formatSubtitles(cues, format),
): void {
  const blob = new Blob([rendered], {
    type:
      format === "vtt" ? "text/vtt;charset=utf-8" : "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name.replace(/\.(srt|vtt)$/i, "")}-checked.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}
