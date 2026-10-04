import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const WSLC = process.env.WSLC_PATH ?? "C:\\Program Files\\WSL\\wslc.exe";

export interface MemoryPeaks {
  /** Peak GPU memory in use on the whole device, MiB (includes the desktop's own share). */
  readonly peakVramMiB: number | undefined;
  /** Peak resident memory of the server container, MiB. */
  readonly peakRamMiB: number | undefined;
  readonly samples: number;
}

async function vramMiB(): Promise<number | undefined> {
  try {
    const { stdout } = await run("nvidia-smi", [
      "--query-gpu=memory.used",
      "--format=csv,noheader,nounits",
    ]);
    return Number.parseFloat(stdout.trim().split("\n")[0]!);
  } catch {
    return undefined;
  }
}

const UNITS: Record<string, number> = {
  B: 1 / 1048576,
  KiB: 1 / 1024,
  MiB: 1,
  GiB: 1024,
  kB: 1 / 1024,
  MB: 1,
  GB: 1024,
};

async function containerRamMiB(container: string): Promise<number | undefined> {
  try {
    const { stdout } = await run(WSLC, ["stats", "--format", "json", container]);
    const used = (JSON.parse(stdout.trim().split("\n")[0]!) as { MemUsage: string }).MemUsage.split(
      "/",
    )[0]!.trim();
    const match = /^([\d.]+)\s*([A-Za-z]+)$/.exec(used);
    return match ? Number.parseFloat(match[1]!) * (UNITS[match[2]!] ?? Number.NaN) : undefined;
  } catch {
    return undefined;
  }
}

export async function sampleVramOnce(): Promise<number | undefined> {
  return vramMiB();
}

/**
 * Memory of the models a remote Ollama has loaded (`GET /api/ps`): VRAM is the part on the GPU,
 * RAM the part offloaded to the CPU. Used when the server runs on a rented pod, not locally.
 */
async function ollamaMiB(ollamaUrl: string): Promise<[number | undefined, number | undefined]> {
  try {
    const response = await fetch(`${ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(10000) });
    const { models } = (await response.json()) as {
      models: { size: number; size_vram: number }[];
    };
    const vram = models.reduce((sum, m) => sum + m.size_vram, 0);
    const size = models.reduce((sum, m) => sum + m.size, 0);
    return [vram / 1048576, (size - vram) / 1048576];
  } catch {
    return [undefined, undefined];
  }
}

/**
 * Polls GPU memory and the container's RAM every `intervalMs` until stopped; keeps the peaks.
 * With `ollamaUrl`, reads both from that Ollama server's `/api/ps` instead.
 */
export function startMemorySampler(
  container: string | undefined,
  intervalMs = 2000,
  ollamaUrl?: string,
): { stop(): Promise<MemoryPeaks> } {
  let peakVram: number | undefined;
  let peakRam: number | undefined;
  let samples = 0;
  let running = true;

  const loop = (async () => {
    while (running) {
      const [vram, ram] = ollamaUrl
        ? await ollamaMiB(ollamaUrl)
        : await Promise.all([vramMiB(), container ? containerRamMiB(container) : undefined]);
      if (vram !== undefined) peakVram = Math.max(peakVram ?? 0, vram);
      if (ram !== undefined) peakRam = Math.max(peakRam ?? 0, ram);
      samples += 1;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();

  return {
    async stop() {
      running = false;
      await loop;
      return { peakVramMiB: peakVram, peakRamMiB: peakRam, samples };
    },
  };
}
