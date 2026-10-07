import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubtitleMeterViewModel } from "../viewmodels/subtitleMeterViewModel";

vi.mock("../services/fileService", () => ({
  readTextFile: vi.fn(
    async () => "1\n00:00:01,000 --> 00:00:03,000\nOriginal caption",
  ),
}));
vi.mock("../services/exportService", () => ({ downloadSubtitles: vi.fn() }));

// 手动控制保存完成时机的 mock（在每个用例内重新实现）
const saveMock = vi.fn();
vi.mock("../repositories/projectRepository", () => ({
  projectRepository: {
    save: (...args: unknown[]) => saveMock(...args),
    load: vi.fn(async () => null),
  },
}));

type Deferred = ReturnType<typeof deferred>;
/** 把一个 deferred 接到保存 mock 上：被调用时发出 started 信号 */
const track = (d: Deferred) => () => {
  d.signal();
  return d.promise;
};

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((res) => (started = res));
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve,
    reject,
    /** 在 mock 被真正调用（flush 已快照 pending）后 resolve */
    started: startedPromise,
    signal: started,
  };
};

describe("连续编辑与保存的先后关系", () => {
  let vm: SubtitleMeterViewModel;
  beforeEach(() => {
    vi.clearAllMocks();
    vm = new SubtitleMeterViewModel();
  });

  async function seed() {
    await vm.importFile(new File(["x"], "clip.srt"));
    saveMock.mockReset();
    const cue = vm.state.project!.cues[0];
    return { cue };
  }

  it("连续编辑发生在写入开始前：合并为一次写入，落盘的就是最新内容", async () => {
    await seed();
    const cue = vm.state.project!.cues[0];

    const first = deferred();
    saveMock.mockImplementationOnce(track(first));

    // 两次编辑都发生在第一次写入实际发起之前（同一同步执行帧）
    const edit1 = vm.editCue(cue.id, { text: "第一次改动" });
    const edit2 = vm.editCue(cue.id, { text: "第二次改动" });

    expect(vm.state.project!.cues[0].text).toBe("第二次改动");

    first.resolve();
    await Promise.all([edit1, edit2]);

    // 中间版本被合并，只有一次写入且写入内容是最新的
    expect(saveMock).toHaveBeenCalledTimes(1);
    const saved = saveMock.mock.calls[0][0] as { cues: { text: string }[] };
    expect(saved.cues[0].text).toBe("第二次改动");
    expect(vm.state.saveStatus).toBe("saved");
  });

  it("写入飞行中又发生编辑：第二次写入排在第一次完成之后，且最后落盘最新内容", async () => {
    await seed();
    const cue = vm.state.project!.cues[0];

    const first = deferred();
    const second = deferred();
    saveMock
      .mockImplementationOnce(track(first))
      .mockImplementationOnce(track(second));

    const edit1 = vm.editCue(cue.id, { text: "第一次改动" });
    // 等第一次写入真正进入飞行态（flush 已快照 pending），再做第二次编辑
    await first.started;
    expect(saveMock.mock.calls[0][0]).toMatchObject({
      cues: [{ text: "第一次改动" }],
    });

    const edit2 = vm.editCue(cue.id, { text: "第二次改动" });
    expect(vm.state.project!.cues[0].text).toBe("第二次改动");
    expect(saveMock).toHaveBeenCalledTimes(1); // 第一次没完成，第二次不能抢先

    first.resolve();
    await edit1;
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));

    second.resolve();
    await edit2;
    const lastSaved = saveMock.mock.calls.at(-1)![0] as {
      cues: { text: string }[];
    };
    expect(lastSaved.cues[0].text).toBe("第二次改动");
    expect(vm.state.saveStatus).toBe("saved");
  });

  it("更早一次保存的迟到结果不能回写/覆盖新一轮改动的状态", async () => {
    await seed();
    const cue = vm.state.project!.cues[0];

    // 第一次保存迟迟不返回，期间发生第二次编辑
    const first = deferred();
    const second = deferred();
    saveMock
      .mockImplementationOnce(track(first))
      .mockImplementationOnce(track(second));

    const edit1 = vm.editCue(cue.id, { text: "A" });
    await first.started; // 第一次写入已快照 A 并进入飞行态
    const edit2 = vm.editCue(cue.id, { text: "AB" });
    expect(saveMock).toHaveBeenCalledTimes(1); // 第二次排在第一次后面

    // 第一次（写的是旧内容 A）失败，但更新的一次保存已在排队，
    // 这个迟到的旧失败不允许报错、也不允许把界面内容打回 A
    first.reject(new Error("磁盘满"));
    await edit1.catch(() => undefined);
    expect(vm.state.project!.cues[0].text).toBe("AB");
    expect(vm.state.saveStatus).toBe("saving");
    expect(vm.state.saveError).toBeNull();

    second.resolve();
    await edit2.catch(() => undefined);
    // 第二次（最新内容 AB）成功后状态才转为已保存
    expect(vm.state.project!.cues[0].text).toBe("AB");
    expect(vm.state.saveStatus).toBe("saved");
    expect(vm.state.saveError).toBeNull();
  });

  it("某次保存失败时提示对应到具体那一次改动", async () => {
    await seed();
    const cue = vm.state.project!.cues[0];

    saveMock.mockRejectedValueOnce(new Error("磁盘不可写"));
    await vm.editCue(cue.id, { text: "改了文本" }).catch(() => undefined);

    expect(vm.state.saveStatus).toBe("error");
    expect(vm.state.saveError).toMatchObject({
      revision: 2, // rev1 是导入，首次编辑是 rev2
      action: expect.stringContaining("文本"),
    });
    expect(vm.state.saveError!.message).toBe("磁盘不可写");
  });

  it("失败后紧跟下一次编辑，失败提示不能被盖掉；直到一次保存成功才消除", async () => {
    await seed();
    const cue = vm.state.project!.cues[0];

    saveMock.mockRejectedValueOnce(new Error("写入失败"));
    await vm.editCue(cue.id, { text: "第一次" }).catch(() => undefined);
    expect(vm.state.saveError).not.toBeNull();

    // 紧跟着的编辑：内容更新，但失败提示必须保留
    saveMock.mockRejectedValueOnce(new Error("还是失败"));
    await vm.editCue(cue.id, { text: "第二次" }).catch(() => undefined);
    expect(vm.state.project!.cues[0].text).toBe("第二次");
    expect(vm.state.saveStatus).toBe("error");
    expect(vm.state.saveError).not.toBeNull();
    expect(vm.state.saveError!.action).toContain("文本");

    // 再下一次保存成功，提示才消除
    saveMock.mockResolvedValueOnce(undefined);
    await vm.retrySave();
    expect(vm.state.saveStatus).toBe("saved");
    expect(vm.state.saveError).toBeNull();
  });

  it("编辑保存与导出同时进行：互不干扰，导出用固定快照、保存继续排队", async () => {
    await seed();
    const cue = vm.state.project!.cues[0];

    const save = deferred();
    saveMock.mockImplementationOnce(track(save));
    const editPromise = vm.editCue(cue.id, { text: "编辑中" });
    expect(vm.state.saveStatus).toBe("saving");

    // 保存未完成时发起导出：phase 切到 exporting，不应影响保存状态
    await vm.exportFile();
    expect(vm.state.phase).toBe("ready"); // 导出（同步）成功
    expect(vm.state.notice).toBe("字幕文件已导出");
    expect(vm.state.saveStatus).toBe("saving"); // 保存仍独立进行

    save.resolve();
    await editPromise;
    expect(vm.state.saveStatus).toBe("saved");
    expect(vm.state.phase).toBe("ready");
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("retrySave 只在非保存中可用，并把最新内容重新落盘", async () => {
    await seed();
    const cue = vm.state.project!.cues[0];

    saveMock.mockRejectedValueOnce(new Error("失败"));
    await vm.editCue(cue.id, { text: "X" }).catch(() => undefined);

    saveMock.mockResolvedValueOnce(undefined);
    await vm.retrySave();
    const retried = saveMock.mock.calls.at(-1)![0] as {
      cues: { text: string }[];
    };
    expect(retried.cues[0].text).toBe("X");
    expect(vm.state.saveStatus).toBe("saved");

    // projectRepository.save 的调用次数只应来自失败 + 重试
    expect(saveMock).toHaveBeenCalledTimes(2);
  });

  it("页面始终显示最新编辑，即使保存尚未完成", async () => {
    await seed();
    const cue = vm.state.project!.cues[0];

    const save = deferred();
    saveMock.mockImplementation(track(save));
    const p = vm.editCue(cue.id, { text: "即时可见" });
    expect(vm.state.project!.cues[0].text).toBe("即时可见");
    save.resolve();
    await p;
    expect(vm.state.project!.cues[0].text).toBe("即时可见");
    expect(vm.state.saveStatus).toBe("saved");
  });
});
