import type { SubtitleProject } from "../models";
const DB_NAME = "subtitle-meter-db",
  STORE = "projects",
  KEY = "subtitle-meter.current.v1";

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  // 复用同一条连接：不同连接上的读写事务之间没有统一的完成顺序，
  // 连续保存时旧内容可能在新内容之后落盘，刷新后就会“退回更早的内容”。
  if (!dbPromise)
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(STORE, { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error ?? new Error("本地存储不可用"));
      };
    });
  return dbPromise;
}

// 所有读写操作都在同一条链上排队：同一连接的事务按入队顺序激活，
// 因此“最后一次编辑”对应的 put 一定最后提交，落盘内容永远是最新版本。
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  // 不让单个任务的失败中断后续排队的任务
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function readProject(): Promise<SubtitleProject | null> {
  return enqueue(async () => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(KEY);
      request.onsuccess = () => {
        const value = request.result;
        resolve(
          value && Array.isArray(value.cues) && Array.isArray(value.versions)
            ? value
            : null,
        );
      };
      request.onerror = () =>
        reject(request.error ?? new Error("本地项目读取失败"));
    });
  });
}

export function writeProject(project: SubtitleProject): Promise<void> {
  return enqueue(async () => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put({ ...project, id: KEY });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("本地保存失败"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("本地保存被中断"));
    });
  });
}
