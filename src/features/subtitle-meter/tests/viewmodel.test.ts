import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubtitleMeterViewModel } from "../viewmodels/subtitleMeterViewModel";
import { projectRepository } from "../repositories/projectRepository";
import { readTextFile } from "../services/fileService";
import { downloadSubtitles } from "../services/exportService";
vi.mock("../services/fileService", () => ({
  readTextFile: vi.fn(
    async () => "1\n00:00:01,000 --> 00:00:03,000\nOriginal caption",
  ),
}));
vi.mock("../repositories/projectRepository", () => ({
  projectRepository: {
    save: vi.fn(async () => undefined),
    load: vi.fn(async () => null),
  },
}));
vi.mock("../services/exportService", () => ({ downloadSubtitles: vi.fn() }));
describe("SubtitleMeterViewModel", () => {
  let vm: SubtitleMeterViewModel;
  beforeEach(() => {
    vm = new SubtitleMeterViewModel();
    vi.mocked(projectRepository.save).mockReset();
    vi.mocked(projectRepository.save).mockResolvedValue(undefined);
    vi.mocked(projectRepository.load).mockReset();
    vi.mocked(projectRepository.load).mockResolvedValue(null);
    vi.mocked(downloadSubtitles).mockReset();
  });
  it("imports, edits, rechecks, snapshots, and exports", async () => {
    await vm.importFile(new File(["x"], "clip.srt"));
    expect(vm.state.phase).toBe("ready");
    const cue = vm.state.project!.cues[0];
    await vm.editCue(cue.id, { text: "Edited" });
    expect(vm.state.project!.cues[0].text).toBe("Edited");
    await vm.saveVersion();
    expect(vm.state.project!.versions).toHaveLength(1);
    await vm.exportFile();
    expect(vm.state.notice).toBe("字幕文件已导出");
  });
  it("keeps a recoverable error when an unsupported import is selected", async () => {
    await vm.importFile(new File(["x"], "clip.txt"));
    expect(vm.state.phase).toBe("error");
    expect(vm.state.notice).toContain("仅支持");
  });
  it("shows a parse failure as a recoverable import error", async () => {
    vi.mocked(readTextFile).mockResolvedValueOnce("not a subtitle block");
    await vm.importFile(new File(["x"], "clip.srt"));
    expect(vm.state.phase).toBe("error");
    expect(vm.state.notice).toContain("缺少时间码");
  });
  it("keeps editing visible immediately and reports export failures", async () => {
    await vm.importFile(new File(["x"], "clip.srt"));
    const cue = vm.state.project!.cues[0];
    const saving = vm.editCue(cue.id, { text: "Immediate edit" });
    expect(vm.state.project!.cues[0].text).toBe("Immediate edit");
    await saving;
    vi.mocked(downloadSubtitles).mockImplementationOnce(() => {
      throw new Error("download unavailable");
    });
    await vm.exportFile();
    expect(vm.state.exporting).toBe(false);
    expect(vm.state.notice).toContain("导出失败");
    expect(vm.state.project!.cues[0].text).toBe("Immediate edit");
  });

  it("rapid consecutive edits: the final save always carries the latest content", async () => {
    await vm.importFile(new File(["x"], "clip.srt"));
    const cue = vm.state.project!.cues[0];
    // 保存慢于编辑：第一次写在微任务层“挂住”，后续编辑在此期间连续产生
    let releaseFirst: () => void = () => undefined;
    const blocking = new Promise<void>((resolve) => (releaseFirst = resolve));
    vi.mocked(projectRepository.save)
      .mockImplementationOnce(() => blocking)
      .mockResolvedValue(undefined);
    const first = vm.editCue(cue.id, { text: "v1" });
    // 让 drainSave 进入 awaiting 状态后再连续提交后续编辑
    await Promise.resolve();
    await Promise.resolve();
    const second = vm.editCue(cue.id, { text: "v2" });
    const third = vm.editCue(cue.id, { text: "v3-final" });
    releaseFirst();
    await Promise.all([first, second, third]);
    const saves = vi.mocked(projectRepository.save).mock.calls;
    const lastSaved = saves.at(-1)![0];
    expect(lastSaved.cues[0].text).toBe("v3-final");
    expect(vm.state.project!.cues[0].text).toBe("v3-final");
    expect(vm.state.saveState).toBe("saved");
  });

  it("a save failure stays attributed to that revision and is not hidden by the next edit", async () => {
    await vm.importFile(new File(["x"], "clip.srt"));
    const cue = vm.state.project!.cues[0];
    vi.mocked(projectRepository.save)
      .mockRejectedValueOnce(new Error("quota"))
      .mockRejectedValueOnce(new Error("quota")) // 内置一次重试也失败
      .mockResolvedValue(undefined);
    await vm.editCue(cue.id, { text: "lost?" });
    expect(vm.state.saveState).toBe("error");
    expect(vm.state.saveErrorRevision).toBe(2); // 导入=1，编辑=2
    expect(vm.state.notice).toContain("第 2 次改动");

    // 紧跟着的下一次编辑不能把错误盖掉：新保存进行中提示被替换，但失败归属仍记录
    const next = vm.editCue(cue.id, { text: "again" });
    expect(vm.state.saveState).toBe("saving");
    await next;
    expect(vm.state.saveState).toBe("saved");
    expect(vm.state.saveErrorRevision).toBeNull();
    const saves = vi.mocked(projectRepository.save).mock.calls;
    expect(saves.at(-1)![0].cues[0].text).toBe("again");
  });

  it("a failing older write does not report error when a newer edit supersedes it", async () => {
    await vm.importFile(new File(["x"], "clip.srt"));
    const cue = vm.state.project!.cues[0];
    let failFirst = true;
    vi.mocked(projectRepository.save).mockImplementation(async (project) => {
      if (failFirst && project.cues[0].text === "old") {
        failFirst = false;
        throw new Error("transient");
      }
    });
    const oldEdit = vm.editCue(cue.id, { text: "old" });
    const newEdit = vm.editCue(cue.id, { text: "new" });
    await Promise.all([oldEdit, newEdit]);
    expect(vm.state.saveState).toBe("saved");
    expect(vm.state.notice).toBe("");
    const saves = vi.mocked(projectRepository.save).mock.calls;
    expect(saves.at(-1)![0].cues[0].text).toBe("new");
  });

  it("saveVersion only reports success after the snapshot is actually persisted", async () => {
    await vm.importFile(new File(["x"], "clip.srt"));
    vi.mocked(projectRepository.save)
      .mockRejectedValueOnce(new Error("disk"))
      .mockRejectedValueOnce(new Error("disk"));
    await vm.saveVersion();
    expect(vm.state.saveState).toBe("error");
    expect(vm.state.notice).toContain("保存失败");
    expect(vm.state.notice).not.toContain("已保存版本快照");
  });

  it("retrySave re-queues the latest content and clears the error on success", async () => {
    await vm.importFile(new File(["x"], "clip.srt"));
    const cue = vm.state.project!.cues[0];
    vi.mocked(projectRepository.save)
      .mockRejectedValueOnce(new Error("disk"))
      .mockRejectedValueOnce(new Error("disk"))
      .mockResolvedValue(undefined);
    await vm.editCue(cue.id, { text: "retry-me" });
    expect(vm.state.saveState).toBe("error");
    await vm.retrySave();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vm.state.saveState).toBe("saved");
    expect(
      vi.mocked(projectRepository.save).mock.calls.at(-1)![0].cues[0].text,
    ).toBe("retry-me");
  });

  it("export and editing do not interfere with each other's status", async () => {
    await vm.importFile(new File(["x"], "clip.srt"));
    const cue = vm.state.project!.cues[0];
    let releaseSave: () => void = () => undefined;
    vi.mocked(projectRepository.save)
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (releaseSave = resolve)),
      )
      .mockResolvedValue(undefined);
    const editing = vm.editCue(cue.id, { text: "during export" });
    await vm.exportFile();
    expect(vm.state.exporting).toBe(false);
    expect(vm.state.notice).toBe("字幕文件已导出");
    // 保存仍独立进行，不受导出影响
    expect(vm.state.saveState).toBe("saving");
    releaseSave();
    await editing;
    expect(vm.state.saveState).toBe("saved");
    // 导出失败也不改变保存状态
    vi.mocked(downloadSubtitles).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await vm.exportFile();
    expect(vm.state.phase).toBe("ready");
    expect(vm.state.saveState).toBe("saved");
    expect(vm.state.notice).toContain("导出失败");
  });

  it("blocks unload while a save is pending or after a save failure", async () => {
    const event = () =>
      ({
        preventDefault: vi.fn(),
        returnValue: "",
      }) as unknown as BeforeUnloadEvent;
    // 没有项目时不拦截
    const idle = event();
    vm.guardBeforeUnload(idle);
    expect(idle.preventDefault).not.toHaveBeenCalled();

    await vm.importFile(new File(["x"], "clip.srt"));
    expect(vm.state.saveState).toBe("saved");
    const saved = event();
    vm.guardBeforeUnload(saved);
    expect(saved.preventDefault).not.toHaveBeenCalled();

    // 保存失败后拦截
    vi.mocked(projectRepository.save)
      .mockRejectedValueOnce(new Error("disk"))
      .mockRejectedValueOnce(new Error("disk"));
    await vm.editCue(vm.state.project!.cues[0].id, { text: "x" });
    const failed = event();
    vm.guardBeforeUnload(failed);
    expect(failed.preventDefault).toHaveBeenCalledTimes(1);
  });
});
