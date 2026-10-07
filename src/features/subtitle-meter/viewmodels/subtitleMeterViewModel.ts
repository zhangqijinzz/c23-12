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
export class SubtitleMeterViewModel {
  state: MeterState = emptyState();
  private listeners = new Set<() => void>();
  /** 每次提交到页面状态的修改递增一次，用于把保存成败对应到具体一次改动 */
  private revision = 0;
  /** 保存队列：旧写入未完成时新写入必须排在后面，保证落盘顺序 */
  private saveChain: Promise<void> = Promise.resolve();
  /** 等待落盘的最新一次改动；更新的改动到来时只替换内容，不打乱排队顺序 */
  private pending: {
    project: SubtitleProject;
    revision: number;
    action: string;
  } | null = null;
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
   * 把一次改动提交到页面并安排落盘。
   * @param action 这次改动的说明（如“编辑条目 #3 文本”），失败时据此提示到具体一次改动
   */
  private async commit(
    project: SubtitleProject,
    action: string,
    phase: MeterState["phase"] = "editing",
  ): Promise<void> {
    project.updatedAt = Date.now();
    const revision = ++this.revision;
    const issues = detectIssues(project.cues);
    // 页面立即显示新内容；保存状态独立维护，不与导入/导出 phase 混用。
    // 已有未恢复的保存失败时继续保留提示，不能被新一次编辑盖掉。
    this.publish({ project, issues, phase, saveStatus: "saving" });
    this.pending = { project, revision, action };
    return this.scheduleSave();
  }
  private scheduleSave(): Promise<void> {
    // 排队执行：前一次 put 的事务完成后才会发起下一次，
    // 配合仓储层的串行队列，最后一次编辑一定最后落盘。
    const run = this.saveChain.then(() => this.flushPending());
    this.saveChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  private async flushPending() {
    const pending = this.pending;
    if (!pending) return;
    // 期间又有新改动入队：本次直接写最新内容，中间版本被合并；
    // 但报错按实际写入的这次改动归因（revision/action 同步取最新）。
    this.pending = null;
    const { project, revision, action } = pending;
    try {
      await projectRepository.save(project);
      // 只有当前状态仍是这次（或更新的一次）改动时才汇报结果，
      // 避免旧调用在新一轮改动之后回写过期状态
      if (revision >= this.revision) {
        this.publish({
          saveStatus: "saved",
          saveError: null, // 一次成功保存消除此前未恢复的失败提示
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "本地保存失败";
      if (revision >= this.revision) {
        // 失败提示绑定到具体这次改动；后续编辑只更新内容，不会清空它，
        // 直到一次保存真正成功。用户不会再误以为已经存住。
        this.publish({
          saveStatus: "error",
          saveError: { revision, action, message },
        });
      }
      throw error;
    }
  }
  /** 失败后用户手动重试：重新落盘当前最新内容 */
  async retrySave() {
    const project = this.state.project;
    if (!project || this.state.saveStatus === "saving") return;
    this.pending = {
      project,
      revision: this.revision,
      action: this.state.saveError?.action ?? "重试保存",
    };
    this.publish({ saveStatus: "saving" });
    try {
      await this.scheduleSave();
    } catch {
      // 失败提示已在 flushPending 中发布
    }
  }
  async restore() {
    try {
      const project = await projectRepository.load();
      if (project) {
        this.publish({
          project,
          issues: detectIssues(project.cues),
          phase: "ready",
          selectedId: project.cues[0]?.id ?? null,
          notice: "已恢复上次编辑",
          saveStatus: "saved",
        });
      }
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
      await this.commit(project, `导入文件 ${file.name}`, "ready");
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
  private cueIndex(id: string) {
    return this.state.project?.cues.find((cue) => cue.id === id)?.index;
  }
  async editCue(
    id: string,
    patch: Partial<Pick<SubtitleCue, "text" | "startMs" | "endMs">>,
  ) {
    if (!this.state.project) return;
    const cues = this.state.project.cues.map((cue) =>
      cue.id === id ? { ...cue, ...patch } : cue,
    );
    const changed =
      "text" in patch ? "文本" : "startMs" in patch ? "开始时间" : "结束时间";
    await this.commit(
      { ...this.state.project, cues },
      `编辑条目 #${this.cueIndex(id) ?? "?"}的${changed}`,
    );
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
    await this.commit(
      { ...project, versions },
      `保存快照 ${project.versions.length + 1}`,
    );
    if (this.state.saveStatus !== "error")
      this.publish({ notice: "已保存版本快照" });
  }
  async restoreVersion(id: string) {
    const project = this.state.project,
      version = project?.versions.find((item) => item.id === id);
    if (!project || !version) return;
    await this.commit(
      { ...project, cues: structuredClone(version.cues) },
      `恢复${version.label}`,
    );
    if (this.state.saveStatus !== "error")
      this.publish({ notice: `已恢复${version.label}` });
  }
  async exportFile() {
    const project = this.state.project;
    if (!project) return;
    // 固定本次导出的快照：导出进行中即便又触发编辑（保存仍在后台排队），
    // 两边操作各自的数据互不干扰。
    const snapshot = project;
    this.publish({ phase: "exporting" });
    try {
      formatSubtitles(snapshot.cues, snapshot.format);
      downloadSubtitles(snapshot.name, snapshot.cues, snapshot.format);
      this.publish({ phase: "ready", notice: "字幕文件已导出" });
    } catch {
      this.publish({
        phase: "error",
        notice: "导出失败，编辑内容已保留，请重试",
      });
    }
  }
  setFormat(format: Format) {
    const project = this.state.project;
    if (project) void this.commit({ ...project, format }, "切换导出格式");
  }
}
export const createViewModel = () => new SubtitleMeterViewModel();
