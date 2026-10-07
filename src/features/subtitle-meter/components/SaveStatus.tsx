import type { MeterState } from "../models";
import type { SubtitleMeterViewModel } from "../viewmodels/subtitleMeterViewModel";

/**
 * 自动保存状态条：保存失败的提示常驻在这里，
 * 不会因为紧跟着的下一次编辑被盖掉，直到下一次保存真正成功。
 */
export function SaveStatus({
  state,
  vm,
  variant = "bar",
}: {
  state: MeterState;
  vm: SubtitleMeterViewModel;
  variant?: "bar" | "pill";
}) {
  if (!state.project) return null;
  if (state.saveState === "saving")
    return (
      <span
        className={`save-status saving save-status-${variant}`}
        role="status"
      >
        <i className="save-dot saving" /> 正在保存第{" "}
        {state.savingRevision ?? ""}
        次改动…
      </span>
    );
  if (state.saveState === "error")
    return (
      <span className={`save-status error save-status-${variant}`} role="alert">
        <i className="save-dot error" /> 第 {state.saveErrorRevision}{" "}
        次改动未保存
        <button
          type="button"
          className="save-retry"
          onClick={() => vm.retrySave()}
        >
          重试
        </button>
        <em>或立即导出备份</em>
      </span>
    );
  return (
    <span className={`save-status saved save-status-${variant}`}>
      <i className="save-dot saved" /> 自动保存已完成
    </span>
  );
}
