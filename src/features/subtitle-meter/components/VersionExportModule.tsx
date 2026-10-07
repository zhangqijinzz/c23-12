import type { Format } from "../models";
import type { SubtitleProject } from "../models";
import type { SubtitleMeterViewModel } from "../viewmodels/subtitleMeterViewModel";
import { SaveStatus } from "./SaveStatus";
export function VersionExportModule({
  project,
  vm,
  state,
}: {
  project: SubtitleProject;
  vm: SubtitleMeterViewModel;
  state: ReturnType<SubtitleMeterViewModel["getSnapshot"]>;
}) {
  return (
    <section className="module version-module">
      <div className="module-head">
        <div>
          <span className="module-kicker">04 / VERSIONS & EXPORT</span>
          <h2>版本与交付</h2>
        </div>
        <SaveStatus state={state} vm={vm} variant="pill" />
      </div>
      <div className="version-row">
        <div>
          <strong>本地快照</strong>
          <small>
            {project.versions.length
              ? `最近：${project.versions.at(-1)?.label}`
              : "保存当前版本以便回退"}
          </small>
        </div>
        <button
          className="secondary-button"
          onClick={() => void vm.saveVersion()}
        >
          ＋ 保存快照
        </button>
      </div>
      {project.versions.length > 0 && (
        <div className="version-list">
          {project.versions.map((version) => (
            <button
              key={version.id}
              onClick={() => void vm.restoreVersion(version.id)}
            >
              {version.label}
              <span>恢复 ↗</span>
            </button>
          ))}
        </div>
      )}
      <div className="export-row">
        <label>
          格式
          <select
            aria-label="导出格式"
            value={project.format}
            onChange={(e) => vm.setFormat(e.target.value as Format)}
          >
            <option value="srt">SRT</option>
            <option value="vtt">WebVTT</option>
          </select>
        </label>
        <button
          className="export-button"
          disabled={state.exporting}
          onClick={() => void vm.exportFile()}
        >
          {state.exporting ? "正在导出…" : "导出字幕"} <span>↓</span>
        </button>
      </div>
      {state.notice && (
        <div
          className={`notice ${state.notice.includes("失败") ? "error" : ""}`}
          role="status"
        >
          {state.notice}
        </div>
      )}
      <p className="privacy-note">字幕文件与项目版本仅保存在当前浏览器</p>
    </section>
  );
}
