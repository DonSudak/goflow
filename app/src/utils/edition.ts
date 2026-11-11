/**
 * Хелперы для определения текущей edition приложения
 *
 * - cloud: полный SaaS (бекенд, auth, биллинг, AI, команды)
 * - oss: self-hosted бекенд без облачных фич
 * - local: без бекенда вообще, данные в ProjectStore (IndexedDB / Tauri fs).
 *   local — надмножество ограничений oss, поэтому isOSS() для него тоже true.
 */
const edition = (): string => process.env.NEXT_PUBLIC_EDITION || 'cloud';

export const isLocal = (): boolean => edition() === 'local';
export const isOSS = (): boolean => edition() === 'oss' || isLocal();
export const isCloud = (): boolean => !isOSS();

/** AI features need the cloud backend (credits, pipelines) */
export const isAIEnabled = (): boolean => !isLocal();
