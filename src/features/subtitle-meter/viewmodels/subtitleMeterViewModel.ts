import { detectIssues } from "../analyzers/issueDetector";
import { formatSubtitles } from "../formatters/subtitleFormatter";
import {
  emptyState,
  type Format,
  type MeterState,
  type SubtitleCue,
  type SubtitleProject,
} from "../models";
import { detectFormat, parseSubtitles } from "../parsers/subtitleParser";
import { projectRepository } from "../repositories/projectRepository";
import { downloadSubtitles } from "../services/exportService";
import { readTextFile } from "../services/fileService";

const SAVE_ATTEMPTS = 2;

export class SubtitleMeterViewModel {
  state: MeterState = emptyState();
  private listeners = new Set<() => void>();
  /** 用户改动序号：每产生一版新内容 +1，用于把保存失败精确归属到具体那一次改动 */
  private revision = 0;
  /** 排队中的保存任务，始终只保留“最新内容”那一个 */
  private pendingSave: { project: SubtitleProject; revision: number } | null =
    null;
  private saveInFlight = false;
  private saveChain: Promise<boolean> = Promise.resolve(false);

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.state;

  private publish(patch: Partial<MeterState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /**
   * 保存队列：任意时刻只有一个写请求在途，连续改动只保留最新内容。
   * 失败时若没有更新的改动产生则立即重试，保证磁盘最终落盘的永远是最新内容。
   */
  private enqueueSave(
    project: SubtitleProject,
    revision: number,
  ): Promise<boolean> {
    this.pendingSave = { project, revision };
    const job = this.saveChain.then(() => this.drainSave());
    this.saveChain = job.then(
      () => false,
      () => false,
    );
    return job;
  }

  private async drainSave(): Promise<boolean> {
    if (this.saveInFlight) return false;
    this.saveInFlight = true;
    try {
      while (this.pendingSave) {
        const { project, revision } = this.pendingSave;
        // 仅当当前展示的不是同一版内容时刷新“正在保存第 N 次”，避免提示闪烁
        if (this.state.savingRevision !== revision) {
          this.publish({ saveState: "saving", savingRevision: revision });
        }
        let written = false;
        for (let attempt = 1; attempt <= SAVE_ATTEMPTS && !written; attempt++) {
          try {
            await projectRepository.save(project);
            written = true;
          } catch {
            // 已有更新内容排队时，旧内容的失败无需提示也无需重试
            if (this.pendingSave?.revision !== revision) break;
            if (attempt === SAVE_ATTEMPTS) break;
          }
        }
        if (!written && this.pendingSave?.revision === revision) {
          // 仍是最新内容却写不进去：失败归属于这一次改动，且不能被后续编辑盖掉
          this.pendingSave = null;
          this.publish({
            saveState: "error",
            saveErrorRevision: revision,
            savingRevision: null,
            notice: `第 ${revision} 次改动本地保存失败；当前修改仍保留在页面中，请立即导出备份后重试`,
          });
          return false;
        }
        if (this.pendingSave?.revision === revision) this.pendingSave = null;
      }
      if (this.state.saveState !== "idle") {
        this.publish({
          saveState: "saved",
          saveErrorRevision: null,
          savingRevision: null,
        });
      }
      return true;
    } finally {
      this.saveInFlight = false;
    }
  }

  /** 保存失败后手动重试（对应页面上的重试入口） */
  retrySave() {
    const project = this.state.project;
    if (!project || this.state.saveState === "saving") return;
    this.revision += 1;
    this.publish({
      saveState: "saving",
      saveErrorRevision: null,
      savingRevision: this.revision,
      notice: "",
    });
    void this.enqueueSave(project, this.revision);
  }

  /**
   * 提交一版新内容：先更新内存（界面立即反映改动），再入队持久化。
   * @returns 这版内容是否确认落盘（被更新的改动取代时返回 false）
   */
  private async commit(
    project: SubtitleProject,
    phase?: MeterState["phase"],
  ): Promise<boolean> {
    project.updatedAt = Date.now();
    const issues = detectIssues(project.cues);
    this.revision += 1;
    const revision = this.revision;
    this.publish({
      project,
      issues,
      ...(phase ? { phase } : {}),
      saveState: "saving",
      saveErrorRevision: null,
      savingRevision: revision,
      // 新改动开始时清掉与保存无关的旧提示；保存失败提示只会由 drainSave 自己覆盖
      notice: "",
    });
    return this.enqueueSave(project, revision);
  }

  /** 页面关闭/刷新前：仍有未落盘内容时提醒用户，避免丢最后一次编辑 */
  guardBeforeUnload = (event: BeforeUnloadEvent) => {
    if (this.state.saveState === "saving" || this.state.saveState === "error") {
      event.preventDefault();
      event.returnValue = "";
    }
  };

  async restore() {
    try {
      const project = await projectRepository.load();
      if (project)
        this.publish({
          project,
          issues: detectIssues(project.cues),
          phase: "ready",
          selectedId: project.cues[0]?.id ?? null,
          notice: "已恢复上次编辑",
          saveState: "saved",
          saveErrorRevision: null,
          savingRevision: null,
        });
    } catch {
      this.publish({ notice: "本地项目暂时无法读取，可继续导入字幕文件" });
    }
  }
  async importFile(file: File) {
    this.publish({ phase: "importing", notice: "正在读取并解析字幕文件…" });
    try {
      const format = detectFormat(file.name),
        text = await readTextFile(file),
        cues = parseSubtitles(text, format);
      const project: SubtitleProject = {
        id: "subtitle-meter.current.v1",
        name: file.name,
        format,
        cues,
        updatedAt: Date.now(),
        versions: [],
      };
      this.publish({
        selectedId: cues[0].id,
        notice: `已解析 ${cues.length} 条字幕`,
      });
      const saved = await this.commit(project, "ready");
      if (saved) this.publish({ notice: `已解析并保存 ${cues.length} 条字幕` });
    } catch (error) {
      this.publish({
        phase: "error",
        notice:
          error instanceof Error ? error.message : "导入失败，请检查文件后重试",
      });
    }
  }
  selectCue(id: string) {
    this.publish({ selectedId: id });
  }
  setZoom(zoom: number) {
    this.publish({ zoom });
  }
  async editCue(
    id: string,
    patch: Partial<Pick<SubtitleCue, "text" | "startMs" | "endMs">>,
  ) {
    if (!this.state.project) return;
    const cues = this.state.project.cues.map((cue) =>
      cue.id === id ? { ...cue, ...patch } : cue,
    );
    await this.commit({ ...this.state.project, cues });
  }
  async saveVersion() {
    const project = this.state.project;
    if (!project) return;
    const versions = [
      ...project.versions,
      {
        id: `v-${Date.now()}`,
        label: `快照 ${project.versions.length + 1}`,
        savedAt: Date.now(),
        cues: structuredClone(project.cues),
      },
    ];
    const saved = await this.commit({ ...project, versions });
    // 只有真正落盘才提示成功，避免“保存没成功却提示成功”
    if (saved) this.publish({ notice: "已保存版本快照" });
  }
  async restoreVersion(id: string) {
    const project = this.state.project,
      version = project?.versions.find((item) => item.id === id);
    if (!project || !version) return;
    const saved = await this.commit({
      ...project,
      cues: structuredClone(version.cues),
    });
    if (saved) this.publish({ notice: `已恢复${version.label}` });
  }
  async exportFile() {
    const project = this.state.project;
    if (!project || this.state.exporting) return;
    // 导出状态独立：不触碰 phase / saveState，与编辑、保存完全隔离
    this.publish({ exporting: true });
    try {
      // 导出的是点击当下的内容，先格式化出独立快照，不与进行中的编辑共享引用
      const content = formatSubtitles(project.cues, project.format);
      downloadSubtitles(project.name, project.cues, project.format, content);
      this.publish({ exporting: false, notice: "字幕文件已导出" });
    } catch {
      this.publish({
        exporting: false,
        notice: "导出失败，编辑内容已保留，请重试",
      });
    }
  }
  setFormat(format: Format) {
    const project = this.state.project;
    if (project) void this.commit({ ...project, format });
  }
}
export const createViewModel = () => new SubtitleMeterViewModel();
