import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { SubtitleProject } from "../models";
import { readProject, writeProject } from "../services/indexedDbService";

const sample: SubtitleProject = {
  id: "subtitle-meter.current.v1",
  name: "sample.srt",
  format: "srt",
  cues: [{ id: "cue-1", index: 1, startMs: 100, endMs: 2000, text: "Saved" }],
  updatedAt: 1,
  versions: [],
};

describe("IndexedDB project storage", () => {
  it("saves and restores the current project", async () => {
    await writeProject(sample);
    expect(await readProject()).toMatchObject({
      name: "sample.srt",
      cues: sample.cues,
    });
  });

  it("downgrades malformed persisted data to an empty project", async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("subtitle-meter-db", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("projects", "readwrite");
      transaction.objectStore("projects").put({
        id: "subtitle-meter.current.v1",
        cues: "corrupted",
        versions: [],
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    expect(await readProject()).toBeNull();
  });

  it("serializes concurrent writes so the last scheduled write is the last on disk", async () => {
    const project = (text: string, updatedAt: number): SubtitleProject => ({
      ...sample,
      cues: [{ ...sample.cues[0], text }],
      updatedAt,
    });

    // 不 await：连续触发，模拟快速编辑
    const writes = [
      writeProject(project("first", 1)),
      writeProject(project("second", 2)),
      writeProject(project("third", 3)),
    ];
    await Promise.all(writes);

    const restored = await readProject();
    expect(restored?.cues[0].text).toBe("third");
    expect(restored?.updatedAt).toBe(3);
  });

  it("keeps reading consistent with the preceding writes through the queue", async () => {
    await writeProject({
      ...sample,
      cues: [{ ...sample.cues[0], text: "latest-on-disk" }],
    });
    const readDuring = readProject();
    const writeAfter = writeProject({
      ...sample,
      cues: [{ ...sample.cues[0], text: "even-newer" }],
    });
    expect((await readDuring)?.cues[0].text).toBe("latest-on-disk");
    await writeAfter;
    expect((await readProject())?.cues[0].text).toBe("even-newer");
  });
});
