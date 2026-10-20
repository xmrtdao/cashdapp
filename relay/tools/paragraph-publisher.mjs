/**
 * Paragraph Publisher — Wrapper for the Manager
 * 
 * Maintained for backward compatibility with the daily-news pipeline.
 * Now a thin wrapper around paragraphPostCreate.
 */
import { paragraphPostCreate } from './paragraph-manager.mjs';

export async function paragraphPublish(args) {
  return await paragraphPostCreate(args);
}

export default paragraphPublish;
