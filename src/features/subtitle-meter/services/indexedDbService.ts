import type { SubtitleProject } from "../models";
const DB_NAME = "subtitle-meter-db",
  STORE = "projects",
  PROJECT_KEY = "subtitle-meter.current.v1";

let dbPromise: Promise<IDBDatabase> | null = null;
/** 所有写入排队串行执行：并发保存时物理落盘顺序必须与调用顺序一致，
 *  旧内容绝不能在新内容之后落盘。 */
let writeChain: Promise<void> = Promise.resolve();

function openDb(): Promise<IDBDatabase> {
  // 复用同一条连接，避免一次保存一开一关造成的事务竞态
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("本地存储不可用"));
  });
  return dbPromise;
}
export async function readProject(): Promise<SubtitleProject | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(PROJECT_KEY);
    request.onsuccess = () => {
      const value = request.result;
      resolve(
        value && Array.isArray(value.cues) && Array.isArray(value.versions)
          ? value
          : null,
      );
    };
    request.onerror = () => reject(request.error);
  });
}
export function writeProject(project: SubtitleProject): Promise<void> {
  const run = writeChain.then(() => persist(project));
  // 失败不应让后续写入永远拿不到队列
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
async function persist(project: SubtitleProject): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put({ ...project, id: PROJECT_KEY });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("本地保存失败"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("本地保存被中止"));
  });
}
