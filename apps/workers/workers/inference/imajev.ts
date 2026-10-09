import sharp from "sharp";
import { z } from "zod";

import serverConfig from "@karakeep/shared/config";

/**
 * Client for imajev, a local decision model that answers multiple-choice
 * questions about text and/or an image. It can't generate text, so it can
 * only pick tags from a list of candidates.
 */

// Server limits: a `multi` question takes at most 32 labels, and a request
// fans out to at most 64 internal fields (one per label).
const MAX_LABELS_PER_QUESTION = 32;
const MAX_LABELS_PER_REQUEST = 64;
// Keeps the state well inside the model's 4096 processed tokens.
const MAX_STATE_VALUE_CHARS = 6000;
// About 1 MP. Bigger images exceed the model's visual token budget.
const MAX_IMAGE_DIMENSION = 1024;

const INSTRUCTIONS =
  "Decide whether this tag fits the bookmark described by the state (its URL, title, description and content) or shown in the image.";

const zImajevResponse = z.object({
  answers: z.record(
    z.string(),
    z.object({
      labels: z.array(z.string()),
    }),
  ),
});

export interface ImajevTaggingInput {
  state: Record<string, string>;
  image?: Buffer;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// The server turns any data:image URL in the state into an extra image.
function sanitizeStateValue(value: string): string {
  return value
    .replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, "[image]")
    .slice(0, MAX_STATE_VALUE_CHARS);
}

async function toJpegDataUrl(image: Buffer): Promise<string> {
  const jpeg = await sharp(image)
    .rotate()
    .resize({
      width: MAX_IMAGE_DIMENSION,
      height: MAX_IMAGE_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/**
 * Returns the candidate tags imajev thinks apply. Throws on any server error,
 * so the job fails and can be retried once imajev is running.
 */
export async function pickTagsWithImajev(
  input: ImajevTaggingInput,
  candidateTags: string[],
  abortSignal: AbortSignal,
): Promise<string[]> {
  const { baseUrl, tagThreshold } = serverConfig.inference.imajev;
  if (!baseUrl) {
    throw new Error("IMAJEV_BASE_URL is not configured");
  }

  const state = Object.fromEntries(
    Object.entries(input.state).map(([k, v]) => [k, sanitizeStateValue(v)]),
  );
  const images = input.image ? [await toJpegDataUrl(input.image)] : [];

  const selected: string[] = [];
  for (const batch of chunk(candidateTags, MAX_LABELS_PER_REQUEST)) {
    const questions = Object.fromEntries(
      chunk(batch, MAX_LABELS_PER_QUESTION).map((labels, i) => [
        `tags${i}`,
        {
          type: "multi",
          instructions: INSTRUCTIONS,
          threshold: tagThreshold,
          criteria: Object.fromEntries(labels.map((l) => [l, null])),
        },
      ]),
    );

    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, images, questions }),
      signal: abortSignal,
    });
    if (!res.ok) {
      const detail = (await res.text()).substring(0, 200);
      throw new Error(`imajev returned HTTP ${res.status}: ${detail}`);
    }

    const body = zImajevResponse.parse(await res.json());
    for (const answer of Object.values(body.answers)) {
      selected.push(...answer.labels);
    }
  }
  return selected;
}
