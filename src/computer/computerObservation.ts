import crypto from 'node:crypto';
import sharp from 'sharp';

import type { ComputerImage } from './midsceneAdapter.ts';

type ScreenshotProfile = 'fast' | 'balanced' | 'detail';

type PreparedObservation = Readonly<{
  image: ComputerImage & Readonly<{
    sourceWidth: number;
    sourceHeight: number;
    scaleX: number;
    scaleY: number;
  }>;
  profile: ScreenshotProfile;
  sourceSha256: string;
}>;

const PROFILE_LONG_EDGE = Object.freeze({
  fast: 1280,
  balanced: 1600,
  detail: Number.POSITIVE_INFINITY
} as const);

function normalizeScreenshotProfile(value: unknown): ScreenshotProfile {
  const profile = String(value || 'balanced').trim().toLowerCase();
  if (profile === 'fast' || profile === 'balanced' || profile === 'detail') return profile;
  throw new Error('screenshot profile must be fast, balanced, or detail.');
}

function computerImageSha256(image: ComputerImage): string {
  return crypto.createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex');
}

async function prepareComputerObservation(
  source: ComputerImage,
  profileValue: unknown = 'balanced'
): Promise<PreparedObservation> {
  const profile = normalizeScreenshotProfile(profileValue);
  const sourceBuffer = Buffer.from(source.data, 'base64');
  const sourceSha256 = crypto.createHash('sha256').update(sourceBuffer).digest('hex');
  const longEdge = Math.max(source.width, source.height);
  const targetLongEdge = PROFILE_LONG_EDGE[profile];

  if (!Number.isFinite(targetLongEdge) || longEdge <= targetLongEdge) {
    return {
      profile,
      sourceSha256,
      image: {
        ...source,
        sourceWidth: source.width,
        sourceHeight: source.height,
        scaleX: 1,
        scaleY: 1
      }
    };
  }

  const ratio = targetLongEdge / longEdge;
  const width = Math.max(1, Math.round(source.width * ratio));
  const height = Math.max(1, Math.round(source.height * ratio));
  try {
    const resized = await sharp(sourceBuffer, { failOn: 'none' })
      .resize({ width, height, fit: 'fill' })
      .png({ compressionLevel: 6 })
      .toBuffer();

    return {
      profile,
      sourceSha256,
      image: {
        mimeType: 'image/png',
        data: resized.toString('base64'),
        bytes: resized.length,
        width,
        height,
        sourceWidth: source.width,
        sourceHeight: source.height,
        scaleX: source.width / width,
        scaleY: source.height / height
      }
    };
  } catch {
    return {
      profile,
      sourceSha256,
      image: {
        ...source,
        sourceWidth: source.width,
        sourceHeight: source.height,
        scaleX: 1,
        scaleY: 1
      }
    };
  }
}

export {
  computerImageSha256,
  normalizeScreenshotProfile,
  prepareComputerObservation
};
export type { ScreenshotProfile };
