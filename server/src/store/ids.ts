import { customAlphabet } from 'nanoid';
const nano = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);
export const newId = (prefix: string) => `${prefix}_${nano()}`;
export const nowIso = () => new Date().toISOString();
